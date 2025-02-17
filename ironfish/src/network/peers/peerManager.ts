/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SignalData } from 'simple-peer'
import WSWebSocket from 'ws'

import { Event } from '../../event'
import { createRootLogger, Logger } from '../../logger'
import { MetricsMonitor } from '../../metrics'
import {
  canInitiateWebRTC,
  canKeepDuplicateConnection,
  Identity,
  isIdentity,
} from '../identity'
import {
  DisconnectingMessage,
  DisconnectingReason,
  IncomingPeerMessage,
  InternalMessageType,
  isDisconnectingMessage,
  isIdentify,
  isMessage,
  isPeerList,
  isSignal,
  isSignalRequest,
  LooseMessage,
  PeerList,
  Signal,
  SignalRequest,
} from '../messages'
import {
  WebRtcConnection,
  WebSocketConnection,
  Connection,
  ConnectionDirection,
  ConnectionType,
  NetworkError,
} from './connections'
import { LocalPeer } from './localPeer'
import { Peer } from './peer'
import { parseUrl } from '../utils'
import { ArrayUtils } from '../../utils'
import { parseVersion, renderVersion, versionsAreCompatible } from '../version'

/**
 * PeerManager keeps the state of Peers and their underlying connections up to date,
 * determines how to establish a connection to a given Peer, and provides an event
 * bus for Peers, e.g. for listening to incoming messages from all connected peers.
 */
export class PeerManager {
  private readonly logger: Logger
  private readonly metrics: MetricsMonitor

  /**
   * Stores data related to the user's peer, like the identity and version
   */
  public readonly localPeer: LocalPeer

  /**
   * Map of identities to peers for every known identified peer in the network.
   */
  readonly identifiedPeers: Map<Identity, Peer> = new Map<Identity, Peer>()

  /**
   * List of all peers, including both unidentified and identified.
   */
  peers: Array<Peer> = []

  /**
   * setInterval handle for broadcastPeerList, which sends out the peer list to all
   * connected peers
   */
  private broadcastPeerListHandle: ReturnType<typeof setInterval> | undefined

  /**
   * setInterval handle for peer disposal, which removes peers from the list that we
   * no longer care about
   */
  private disposePeersHandle: ReturnType<typeof setInterval> | undefined

  /**
   * Event fired when a new connection is successfully opened. Sends some identifying
   * information about the peer.
   *
   * This event is fired regardless of whether or not we initiated the connection.
   */
  readonly onConnect: Event<[Peer]> = new Event()

  /**
   * Event fired when an identified peer is disconnected for some reason.
   */
  readonly onDisconnect: Event<[Peer]> = new Event()

  /**
   * Event fired for every new incoming message that needs to be processed
   * by the application layer.
   *
   * Note that the `Peer` is the peer that sent it to us,
   * not necessarily the original source.
   */
  readonly onMessage: Event<[Peer, IncomingPeerMessage<LooseMessage>]> = new Event()

  /**
   * Event fired when a peer's knownPeers list changes.
   */
  readonly onKnownPeersChanged: Event<[Peer]> = new Event()

  /**
   * Event fired when a peer enters or leaves the CONNECTED state.
   */
  readonly onConnectedPeersChanged: Event<[]> = new Event()

  /**
   * The maximum number of peers allowed to be in the CONNECTED or CONNECTING state.
   */
  readonly maxPeers: number

  /**
   * Stops establishing connections to DISCONNECTED peers when at or above this number.
   */
  readonly targetPeers: number

  constructor(
    localPeer: LocalPeer,
    logger: Logger = createRootLogger(),
    metrics?: MetricsMonitor,
    maxPeers = 10000,
    targetPeers = 50,
  ) {
    this.logger = logger.withTag('peermanager')
    this.metrics = metrics || new MetricsMonitor(this.logger)
    this.localPeer = localPeer
    this.maxPeers = maxPeers
    this.targetPeers = targetPeers
  }

  /**
   * Connect to a websocket by its uri. Establish a connection and solicit
   * the server's Identity.
   */
  connectToWebSocketAddress(uri: string, isWhitelisted = false): Peer {
    const url = parseUrl(uri)

    if (!url.hostname) {
      throw new Error(`Could not connect to ${uri} because hostname was not parseable`)
    }

    const peer = this.getOrCreatePeer(null)
    peer.setWebSocketAddress(url.hostname, url.port)
    peer.isWhitelisted = isWhitelisted
    this.connectToWebSocket(peer)
    return peer
  }

  /**
   * Connect to a peer using WebSockets
   * */
  connectToWebSocket(peer: Peer): boolean {
    if (!this.canConnectToWebSocket(peer)) return false

    // If we're trying to connect to the peer, we don't care about limiting the peer's connections to us
    peer.localRequestedDisconnectUntil = null
    peer.localRequestedDisconnectReason = null

    // Clear out peerRequestedDisconnect if we passed it
    peer.peerRequestedDisconnectUntil = null
    peer.peerRequestedDisconnectReason = null

    const address = peer.getWebSocketAddress()
    if (!address) {
      peer
        .getConnectionRetry(ConnectionType.WebSocket, ConnectionDirection.Outbound)
        .failedConnection(peer.isWhitelisted)

      return false
    }

    this.initWebSocketConnection(
      peer,
      new this.localPeer.webSocket(address),
      ConnectionDirection.Outbound,
      peer.address,
      peer.port,
    )

    return true
  }

  /**
   * Connect to a peer using WebRTC through another peer
   * */
  connectToWebRTC(peer: Peer): boolean {
    if (!this.canConnectToWebRTC(peer)) return false

    // If we're trying to connect to the peer, we don't care about limiting the peer's connections to us
    peer.localRequestedDisconnectUntil = null
    peer.localRequestedDisconnectReason = null

    // Clear out peerRequestedDisconnect if we passed it
    peer.peerRequestedDisconnectUntil = null
    peer.peerRequestedDisconnectReason = null

    if (peer.state.identity === null) {
      peer
        .getConnectionRetry(ConnectionType.WebRtc, ConnectionDirection.Outbound)
        .failedConnection(peer.isWhitelisted)

      return false
    }

    const brokeringPeer = this.getBrokeringPeer(peer)

    if (brokeringPeer === null) {
      this.logger.debug(
        `Attempted to establish a WebRTC connection to ${peer.displayName}, but couldn't find a peer to broker the connection.`,
      )

      peer
        .getConnectionRetry(ConnectionType.WebRtc, ConnectionDirection.Outbound)
        .failedConnection(peer.isWhitelisted)

      // If we don't have any brokering peers try disposing the peers
      this.tryDisposePeer(peer)
      return false
    }

    if (canInitiateWebRTC(this.localPeer.publicIdentity, peer.state.identity)) {
      this.initWebRtcConnection(brokeringPeer, peer, true)
      return true
    }

    const signal: SignalRequest = {
      type: InternalMessageType.signalRequest,
      payload: {
        sourceIdentity: this.localPeer.publicIdentity,
        destinationIdentity: peer.state.identity,
      },
    }

    const connection = this.initWebRtcConnection(brokeringPeer, peer, false)
    connection.setState({ type: 'REQUEST_SIGNALING' })
    brokeringPeer.send(signal)
    return true
  }

  createPeerFromInboundWebSocketConnection(
    webSocket: WebSocket | WSWebSocket,
    address: string | null,
  ): Peer {
    const peer = this.getOrCreatePeer(null)

    let hostname: string | null = null
    let port: number | null = null

    if (address) {
      const url = parseUrl(address)

      if (url.hostname) {
        hostname = url.hostname
        port = url.port
      }
    }

    this.initWebSocketConnection(peer, webSocket, ConnectionDirection.Inbound, hostname, port)

    return peer
  }

  /**
   * Perform WebSocket-specific connection setup.
   */
  private initWebSocketConnection(
    peer: Peer,
    ws: WebSocket | WSWebSocket,
    direction: ConnectionDirection,
    hostname: string | null,
    port: number | null,
  ): WebSocketConnection {
    const connection = new WebSocketConnection(ws, direction, this.logger, this.metrics, {
      simulateLatency: this.localPeer.simulateLatency,
      hostname: hostname || undefined,
      port: port || undefined,
    })

    this.initConnectionHandlers(peer, connection)
    peer.setWebSocketConnection(connection)

    return connection
  }

  /**
   * Perform WebRTC-specific connection setup
   * @param brokeringPeer The peer used to exchange signaling messages between us and `peer`
   * @param peer The peer to establish a connection with
   * @param initiator Set to true if we are initiating a connection with `peer`
   */
  private initWebRtcConnection(
    brokeringPeer: Peer,
    peer: Peer,
    initiator: boolean,
  ): WebRtcConnection {
    const connection = new WebRtcConnection(
      initiator,
      this.localPeer.webRtc,
      this.logger,
      this.metrics,
      { simulateLatency: this.localPeer.simulateLatency },
    )

    connection.onSignal.on((data) => {
      if (peer.state.identity === null) {
        const message = 'Cannot establish a WebRTC connection without a peer identity'
        this.logger.debug(message)
        connection.close(new NetworkError(message))
        return
      }
      const { nonce, boxedMessage } = this.localPeer.boxMessage(
        JSON.stringify(data),
        peer.state.identity,
      )
      const signal: Signal = {
        type: InternalMessageType.signal,
        payload: {
          sourceIdentity: this.localPeer.publicIdentity,
          destinationIdentity: peer.state.identity,
          nonce: nonce,
          signal: boxedMessage,
        },
      }
      brokeringPeer.send(signal)
    })

    this.initConnectionHandlers(peer, connection)
    peer.setWebRtcConnection(connection)

    return connection
  }

  /**
   * Set up event handlers that are common among all connection types.
   * @param connection An instance of a Connection.
   */
  private initConnectionHandlers(peer: Peer, connection: Connection) {
    if (connection.state.type === 'WAITING_FOR_IDENTITY') {
      connection.send(this.localPeer.getIdentifyMessage())
    } else {
      const handler = () => {
        if (connection.state.type === 'WAITING_FOR_IDENTITY') {
          connection.send(this.localPeer.getIdentifyMessage())
          connection.onStateChanged.off(handler)
        }
      }
      connection.onStateChanged.on(handler)
    }
  }

  canConnectToWebSocket(peer: Peer, now = Date.now()): boolean {
    const canEstablishNewConnection =
      peer.state.type !== 'DISCONNECTED' ||
      this.getPeersWithConnection().length < this.targetPeers

    const disconnectOk =
      peer.peerRequestedDisconnectUntil === null || now >= peer.peerRequestedDisconnectUntil

    const hasNoConnection =
      peer.state.type === 'DISCONNECTED' || peer.state.connections.webSocket == null

    const retryOk =
      peer.getConnectionRetry(ConnectionType.WebSocket, ConnectionDirection.Outbound)
        ?.canConnect || false

    return (
      canEstablishNewConnection &&
      disconnectOk &&
      hasNoConnection &&
      retryOk &&
      peer.address != null
    )
  }

  canConnectToWebRTC(peer: Peer, now = Date.now()): boolean {
    const canEstablishNewConnection =
      peer.state.type !== 'DISCONNECTED' ||
      this.getPeersWithConnection().length < this.targetPeers

    const disconnectOk =
      peer.peerRequestedDisconnectUntil === null || now >= peer.peerRequestedDisconnectUntil

    const hasNoConnection =
      peer.state.type === 'DISCONNECTED' || peer.state.connections.webRtc == null

    const retryOk =
      peer.getConnectionRetry(ConnectionType.WebRtc, ConnectionDirection.Outbound)
        ?.canConnect || false

    return (
      canEstablishNewConnection &&
      disconnectOk &&
      hasNoConnection &&
      retryOk &&
      peer.state.identity != null
    )
  }

  /**
   * Initiate a disconnection from another peer.
   * @param peer The peer to disconnect from
   * @param reason The reason for disconnecting from the peer
   * @param until Stay disconnected from the peer until after this timestamp
   */
  disconnect(peer: Peer, reason: DisconnectingReason, until: number): void {
    peer.localRequestedDisconnectReason = reason
    peer.localRequestedDisconnectUntil = until

    if (peer.state.type === 'DISCONNECTED') {
      return
    }

    const message: DisconnectingMessage = {
      type: InternalMessageType.disconnecting,
      payload: {
        sourceIdentity: this.localPeer.publicIdentity,
        destinationIdentity: peer.state.identity,
        reason,
        disconnectUntil: until,
      },
    }

    const canSend = (connection: Connection): boolean => {
      return (
        connection.state.type === 'WAITING_FOR_IDENTITY' ||
        connection.state.type === 'CONNECTED'
      )
    }

    if (peer.state.connections.webRtc && canSend(peer.state.connections.webRtc)) {
      peer.state.connections.webRtc.send(message)
    }

    if (peer.state.connections.webSocket && canSend(peer.state.connections.webSocket)) {
      peer.state.connections.webSocket.send(message)
    }

    peer.close()
  }

  getPeersWithConnection(): ReadonlyArray<Peer> {
    return this.peers.filter((p) => p.state.type !== 'DISCONNECTED')
  }

  getConnectedPeers(): ReadonlyArray<Peer> {
    return [...this.identifiedPeers.values()].filter((p) => {
      return p.state.type === 'CONNECTED'
    })
  }

  /**
   * True if we should reject connections from disconnected Peers.
   */
  shouldRejectDisconnectedPeers(): boolean {
    return this.getPeersWithConnection().length >= this.maxPeers
  }

  /** For a given peer, try to find a peer that's connected to that peer
   * including itself to broker a WebRTC connection to it
   * */
  private getBrokeringPeer(peer: Peer): Peer | null {
    if (peer.state.type === 'CONNECTED') {
      // Use the existing connection to the peer to broker the connection
      return peer
    }

    if (peer.state.identity === null) {
      // Cannot find a brokering peer of an unidentified peer
      return null
    }

    // Find another peer to broker the connection
    const candidates = []

    // The peer should know of any brokering peer candidates
    for (const [_, candidate] of peer.knownPeers) {
      if (
        // The brokering peer candidate should be connected to the local peer
        candidate.state.type === 'CONNECTED' &&
        // the brokering peer candidate should also know of the peer
        candidate.knownPeers.has(peer.state.identity)
      ) {
        candidates.push(candidate)
      }
    }

    if (candidates.length === 0) {
      return null
    }

    return ArrayUtils.sampleOrThrow(candidates)
  }

  /**
   * This function puts a peer in the identified peers map and should be called once
   * a peer is connected, meaning it has a connection tht has received an identity
   */
  private updateIdentifiedPeerMap(peer: Peer): void {
    if (peer.state.identity == null) {
      this.logger.warn('updateIdentifiedPeerMap called with a Peer with null identity')
      return
    }

    // If we don't have a Peer in the Map for this identity, set it and be done
    const existingPeer = this.identifiedPeers.get(peer.state.identity)
    if (!existingPeer || peer === existingPeer) {
      this.identifiedPeers.set(peer.state.identity, peer)
      return
    }

    // Merge the connections from the new peer onto the existing peer. We want to keep
    // the existing peer since someone may be holding a reference
    if (peer.state.type === 'DISCONNECTED') {
      this.logger.debug(`Trying to dispose disconnected peer ${peer.displayName}`)
      peer.close()
      this.tryDisposePeer(peer)
      return
    }

    if (peer.state.connections.webRtc?.state.type === 'CONNECTED') {
      if (existingPeer.state.type !== 'DISCONNECTED' && existingPeer.state.connections.webRtc) {
        const error = `Replacing duplicate WebRTC connection on ${existingPeer.displayName}`
        this.logger.debug(new NetworkError(error))
        existingPeer
          .removeConnection(existingPeer.state.connections.webRtc)
          .close(new NetworkError(error))
      }
      existingPeer.setWebRtcConnection(peer.state.connections.webRtc)
      peer.removeConnection(peer.state.connections.webRtc)
    }

    if (peer.state.connections.webSocket?.state.type === 'CONNECTED') {
      if (
        existingPeer.state.type !== 'DISCONNECTED' &&
        existingPeer.state.connections.webSocket
      ) {
        const error = `Replacing duplicate WebSocket connection on ${existingPeer.displayName}`
        this.logger.debug(error)
        existingPeer
          .removeConnection(existingPeer.state.connections.webSocket)
          .close(new NetworkError(error))
      }
      existingPeer.setWebSocketConnection(peer.state.connections.webSocket)
      peer.removeConnection(peer.state.connections.webSocket)
    }

    // Clean up data so that the duplicate peer can be disposed
    peer
      .getConnectionRetry(ConnectionType.WebSocket, ConnectionDirection.Outbound)
      ?.neverRetryConnecting()

    this.tryDisposePeer(peer)
  }

  /**
   * Given an identity, returns the Peer corresponding to that identity,
   * or null if no Peer for that identity exists.
   * @param identity A peer identity.
   */
  getPeer(identity: Identity): Peer | null {
    return this.identifiedPeers.get(identity) || null
  }

  /**
   * Given an identity, fetch a Peer with that identity or throw an error
   * @param identity A peer identity.
   */
  getPeerOrThrow(identity: Identity): Peer {
    const peer = this.identifiedPeers.get(identity)
    if (peer != null) {
      return peer
    }
    throw new Error(`No peer found with identity ${identity}`)
  }

  /**
   * If a null identity is passed, creates a new Peer. If an identity is passed, returns the Peer
   * if we already have one with that identity, else creates a new Peer with that identity.
   * @param identity The identity of the peer to create, or null if the peer does not yet have one.
   */
  getOrCreatePeer(identity: Identity | null): Peer {
    // If we already have a Peer with this identity, return it
    if (identity !== null) {
      const identifiedPeer = this.identifiedPeers.get(identity)
      if (identifiedPeer != null) {
        return identifiedPeer
      }
    }

    // Create the new peer
    const peer = new Peer(identity, { logger: this.logger })

    // Add the peer to peers. It's new, so it shouldn't exist there already
    this.peers.push(peer)

    // If the peer hasn't been identified, add it to identifiedPeers when the
    // peer connects, else do it now
    if (peer.state.identity === null) {
      const handler = () => {
        if (peer.state.type === 'CONNECTED') {
          this.updateIdentifiedPeerMap(peer)
          peer.onStateChanged.off(handler)
        }
      }
      peer.onStateChanged.on(handler)
    } else {
      this.updateIdentifiedPeerMap(peer)
    }

    // Bind Peer events to PeerManager events
    peer.onMessage.on((message, connection) => {
      this.handleMessage(peer, connection, message)
    })

    peer.onKnownPeersChanged.on(() => {
      this.onKnownPeersChanged.emit(peer)
    })

    peer.onStateChanged.on(({ prevState }) => {
      if (prevState.type !== 'CONNECTED' && peer.state.type === 'CONNECTED') {
        this.onConnect.emit(peer)
        this.onConnectedPeersChanged.emit()
      }
      if (prevState.type === 'CONNECTED' && peer.state.type !== 'CONNECTED') {
        this.onDisconnect.emit(peer)
        this.onConnectedPeersChanged.emit()
        this.tryDisposePeer(peer)
      }
    })

    return peer
  }

  /**
   * Send a message to a peer, dropping the message if unable.
   * @param peer The peer identity to send a message to.
   * @param message The message to send.
   */
  sendTo(peer: Peer, message: LooseMessage): Connection | null {
    return peer.send(message)
  }

  /**
   * Send a message to all connected peers.
   */
  broadcast(message: LooseMessage): void {
    for (const peer of this.identifiedPeers.values()) {
      if (peer.state.type === 'CONNECTED') {
        peer.send(message)
      }
    }
  }

  start(): void {
    this.broadcastPeerListHandle = setInterval(() => this.broadcastPeerList(), 5000)
    this.disposePeersHandle = setInterval(() => this.disposePeers(), 2000)
  }

  /**
   * Call when shutting down the PeerManager to clean up
   * outstanding connections.
   */
  stop(): void {
    this.broadcastPeerListHandle && clearInterval(this.broadcastPeerListHandle)
    this.disposePeersHandle && clearInterval(this.disposePeersHandle)
    for (const peer of this.peers) {
      this.disconnect(peer, DisconnectingReason.ShuttingDown, 0)
    }
  }

  /**
   * Send the list of peer IDs I am connected to to each of those peers.
   * This is expected to be called periodically, both as a keep-alive and
   * to help peers keep their view of the network up-to-date.
   */
  private broadcastPeerList() {
    const connectedPeers = []

    for (const p of this.identifiedPeers.values()) {
      if (p.state.type !== 'CONNECTED') continue

      // Worker nodes are nodes that should not be broadcast because they are
      // meant to connect to a single node and perform one function
      if (p.isWorker && !this.localPeer.broadcastWorkers) continue

      connectedPeers.push({
        identity: p.state.identity,
        name: p.name || undefined,
        address: p.address,
        port: p.port,
      })
    }

    const peerList: PeerList = {
      type: InternalMessageType.peerList,
      payload: { connectedPeers },
    }

    this.broadcast(peerList)
  }

  private disposePeers(): void {
    for (const p of this.peers) {
      this.tryDisposePeer(p)
    }
  }

  /**
   * Returns true if we successfully cleaned up the Peer and removed it from PeerManager,
   * else returns false and does nothing.
   * @param peer The peer to evaluate
   */
  private tryDisposePeer(peer: Peer) {
    const hasAConnectedPeer = [...peer.knownPeers.values()].some(
      (p) => p.state.type === 'CONNECTED',
    )

    if (
      peer.state.type === 'DISCONNECTED' &&
      !hasAConnectedPeer &&
      peer.getConnectionRetry(ConnectionType.WebSocket, ConnectionDirection.Outbound)
        ?.willNeverRetryConnecting
    ) {
      this.logger.debug(
        `Disposing of peer with identity ${String(peer.state.identity)} (may be a duplicate)`,
      )

      peer.dispose()
      if (peer.state.identity && this.identifiedPeers.get(peer.state.identity) === peer) {
        this.identifiedPeers.delete(peer.state.identity)
      }
      this.peers = this.peers.filter((p) => p !== peer)

      return true
    }
    return false
  }

  /**
   * Handler fired whenever we receive any message from a peer.
   *
   * If it is a signal message we need to forward it to the appropriate
   * webrtc peer.
   *
   * Note that the identity on IncomingPeerMessage is the identity of the
   * peer that sent it to us, not the original source.
   */
  private handleMessage(peer: Peer, connection: Connection, message: LooseMessage) {
    if (isDisconnectingMessage(message)) {
      this.handleDisconnectingMessage(peer, message)
    } else if (connection.state.type === 'WAITING_FOR_IDENTITY') {
      this.handleWaitingForIdentityMessage(peer, connection, message)
    } else if (isIdentify(message)) {
      this.logger.debug(
        `Closing connection to ${peer.displayName} that sent identity ${message.payload.identity} while connection is in state ${connection.state.type}`,
      )
    } else if (isSignalRequest(message)) {
      this.handleSignalRequestMessage(peer, message)
    } else if (isSignal(message)) {
      this.handleSignalMessage(peer, message)
    } else if (isPeerList(message)) {
      this.handlePeerListMessage(message, peer)
    } else {
      if (peer.state.identity == null) {
        const messageType = isMessage(message) ? message.type : 'Unknown'
        this.logger.debug(
          `Closing connection to unidentified peer that sent an unexpected message: ${messageType}`,
        )
        peer.close()
        return
      }
      this.onMessage.emit(peer, { peerIdentity: peer.state.identity, message: message })
    }
  }

  private handleDisconnectingMessage(messageSender: Peer, message: DisconnectingMessage) {
    if (
      message.payload.destinationIdentity !== this.localPeer.publicIdentity &&
      message.payload.destinationIdentity !== null
    ) {
      // Only forward it if the message was received from the same peer as it originated from
      if (message.payload.sourceIdentity !== messageSender.state.identity) {
        this.logger.debug(
          `not forwarding disconnect from ${
            messageSender.displayName
          } because the message's source identity (${
            message.payload.sourceIdentity
          }) doesn't match the sender's identity (${String(messageSender.state.identity)})`,
        )
        return
      }

      const destinationPeer = this.getPeer(message.payload.destinationIdentity)

      if (!destinationPeer) {
        this.logger.debug(
          'not forwarding disconnect from',
          messageSender.displayName,
          'due to unknown peer',
          message.payload.destinationIdentity,
        )
        return
      }

      this.sendTo(destinationPeer, message)
      return
    }

    messageSender.peerRequestedDisconnectReason = message.payload.reason
    messageSender.peerRequestedDisconnectUntil = message.payload.disconnectUntil
    this.logger.debug(
      `${messageSender.displayName} requested we disconnect until ${
        message.payload.disconnectUntil
      }. Current time is ${Date.now()}`,
    )
    messageSender.close()
  }

  /**
   * Handle messages received when the peer is in the WAITING_FOR_IDENTITY state.
   *
   * @param message The message received.
   * @param peer The Peer the message was received from.
   * @param connection The Connection the message was received from.
   */
  private handleWaitingForIdentityMessage(
    peer: Peer,
    connection: Connection,
    message: LooseMessage,
  ): void {
    // If we receive any message other than an Identity message, close the connection
    if (!isIdentify(message)) {
      this.logger.debug(
        `Disconnecting from ${peer.displayName} - Sent unexpected message ${message.type} while waiting for identity`,
      )
      peer.close()
      return
    }

    const identity = message.payload.identity
    const version = parseVersion(message.payload.version)
    const port = message.payload.port
    const name = message.payload.name || null

    if (!isIdentity(identity)) {
      this.logger.debug(
        `Disconnecting from ${identity} - Identity does not match expected format`,
      )
      peer
        .getConnectionRetry(connection.type, connection.direction)
        ?.failedConnection(peer.isWhitelisted)
      peer.close(new Error(`Identity ${identity} does not match expected format`))
      return
    }

    if (!versionsAreCompatible(this.localPeer.version, version)) {
      const error = `Peer version ${
        message.payload.version
      } is not compatible to ours: ${renderVersion(this.localPeer.version)}`

      this.logger.debug(`Disconnecting from ${identity} - ${error}`)
      peer
        .getConnectionRetry(connection.type, connection.direction)
        ?.failedConnection(peer.isWhitelisted)
      peer.close(new Error(error))
      return
    }

    if (name && name.length > 32) {
      this.logger.debug(
        `Disconnecting from ${identity} - Peer name length exceeds 32: ${name.length}}`,
      )
      peer
        .getConnectionRetry(connection.type, connection.direction)
        ?.failedConnection(peer.isWhitelisted)
      peer.close(new Error(`Peer name length exceeds 32: ${name.length}}`))
      return
    }

    // If we've connected to ourselves, get rid of the connection and take the address and port off the Peer.
    // This can happen if a node stops and starts with a different identity
    if (identity === this.localPeer.publicIdentity) {
      peer.removeConnection(connection)
      peer.getConnectionRetry(connection.type, connection.direction)?.neverRetryConnecting()

      if (
        connection.type === ConnectionType.WebSocket &&
        connection.direction === ConnectionDirection.Outbound
      ) {
        peer.setWebSocketAddress(null, null)
      }

      const error = `Closing ${connection.type} connection from our own identity`
      this.logger.debug(error)
      connection.close(new NetworkError(error))
      this.tryDisposePeer(peer)
      return
    }

    // If we already know the peer's identity and the new identity doesn't match, move the connection
    // to a Peer with the new identity.
    if (peer.state.identity != null && peer.state.identity !== identity) {
      this.logger.debug(
        `${peer.displayName} sent identity ${identity}, but already has identity ${peer.state.identity}`,
      )

      peer.removeConnection(connection)
      peer.getConnectionRetry(connection.type, connection.direction)?.neverRetryConnecting()

      const originalPeer = peer
      peer = this.getOrCreatePeer(identity)

      if (connection instanceof WebRtcConnection) {
        peer.setWebRtcConnection(connection)
      } else if (connection instanceof WebSocketConnection) {
        if (
          connection.type === ConnectionType.WebSocket &&
          connection.direction === ConnectionDirection.Outbound &&
          originalPeer.address !== null
        ) {
          peer.setWebSocketAddress(originalPeer.address, originalPeer.port)
          originalPeer.setWebSocketAddress(null, null)
        }
        peer.setWebSocketConnection(connection)
      }
    }

    const existingPeer = this.getPeer(identity)

    // Check if already have a duplicate websocket connection from this peer
    //
    // This probably happened because either we connected to each other at the same time,
    // or the other side is trying to establish multiple connections to us which is invalid
    // behaviour. We should kill the peer / connection that was initiated by the peer with
    // the lower identity
    if (
      existingPeer !== null &&
      existingPeer.state.type === 'CONNECTED' &&
      existingPeer.state.connections.webSocket &&
      connection.type === ConnectionType.WebSocket
    ) {
      const existingConnection = existingPeer.state.connections.webSocket
      let connectionToClose = connection

      // We keep the other persons outbound connection
      if (canKeepDuplicateConnection(identity, this.localPeer.publicIdentity)) {
        if (connection.direction === ConnectionDirection.Outbound) {
          connectionToClose = connection
        } else if (existingConnection.direction === ConnectionDirection.Outbound) {
          connectionToClose = existingConnection
        }
      }

      // We keep our outbound connection
      if (canKeepDuplicateConnection(this.localPeer.publicIdentity, identity)) {
        if (connection.direction === ConnectionDirection.Inbound) {
          connectionToClose = connection
        } else if (existingConnection.direction === ConnectionDirection.Inbound) {
          connectionToClose = existingConnection
        }
      }

      const error = `Closing duplicate ${connectionToClose.type} connection with direction ${connectionToClose.direction}`
      this.logger.debug(error)
      connectionToClose.close(new NetworkError(error))

      if (connectionToClose === connection) return
    }

    // Inbound WebSocket connections come with an address but no port, so we need to
    // pull the port from the identity message onto the connection. In cases where we
    // attempt to establish an outbound WebSocket connection, we should have received
    // the port via the peer list or user input, so we can ignore it.
    if (
      connection instanceof WebSocketConnection &&
      connection.direction === ConnectionDirection.Inbound
    ) {
      connection.port = port || undefined
    }

    peer.name = name
    peer.isWorker = message.payload.isWorker || false
    peer.version = version

    // If we've told the peer to stay disconnected, repeat
    // the disconnection time before closing the connection
    if (
      existingPeer !== null &&
      existingPeer.localRequestedDisconnectUntil !== null &&
      Date.now() < existingPeer.localRequestedDisconnectUntil
    ) {
      const disconnectMessage: DisconnectingMessage = {
        type: InternalMessageType.disconnecting,
        payload: {
          sourceIdentity: this.localPeer.publicIdentity,
          destinationIdentity: identity,
          reason: existingPeer.localRequestedDisconnectReason || DisconnectingReason.Congested,
          disconnectUntil: existingPeer.localRequestedDisconnectUntil,
        },
      }
      connection.send(disconnectMessage)

      const error = `Closing connection from ${
        existingPeer.displayName
      } because they connected at ${Date.now()}, but we told them to disconnect until ${
        existingPeer.localRequestedDisconnectUntil
      }`
      this.logger.debug(error)
      connection.close(new NetworkError(error))
      return
    }

    // Identity has been successfully validated, update the peer's state
    connection.setState({ type: 'CONNECTED', identity: identity })
  }

  /**
   * Handle a signal request message relayed by another peer.
   * @param message An incoming SignalRequest message from a peer.
   */
  private handleSignalRequestMessage(messageSender: Peer, message: SignalRequest) {
    if (
      canInitiateWebRTC(message.payload.sourceIdentity, message.payload.destinationIdentity)
    ) {
      this.logger.debug(
        'not handling signal request from',
        message.payload.sourceIdentity,
        'to',
        message.payload.destinationIdentity,
        'because source peer should have initiated',
      )
      return
    }

    // Forward the message if it's not destined for us
    if (message.payload.destinationIdentity !== this.localPeer.publicIdentity) {
      // Only forward it if the message was received from the same peer as it originated from
      if (message.payload.sourceIdentity !== messageSender.state.identity) {
        this.logger.debug(
          `not forwarding signal request from ${
            messageSender.displayName
          } because the message's source identity (${
            message.payload.sourceIdentity
          }) doesn't match the sender's identity (${String(messageSender.state.identity)})`,
        )
        return
      }

      const destinationPeer = this.getPeer(message.payload.destinationIdentity)

      if (!destinationPeer) {
        this.logger.debug(
          'not forwarding signal request from',
          messageSender.displayName,
          'due to unknown peer',
          message.payload.destinationIdentity,
        )
        return
      }

      this.sendTo(destinationPeer, message)
      return
    }

    // Ignore the request if we're at max peers and don't have an existing connection
    if (this.shouldRejectDisconnectedPeers()) {
      const peer = this.getPeer(message.payload.sourceIdentity)
      if (!peer || peer.state.type !== 'CONNECTED') {
        const disconnectingMessage: DisconnectingMessage = {
          type: InternalMessageType.disconnecting,
          payload: {
            sourceIdentity: this.localPeer.publicIdentity,
            destinationIdentity: message.payload.sourceIdentity,
            reason: DisconnectingReason.Congested,
            disconnectUntil: 1000 * 60 * 5,
          },
        }
        messageSender.send(disconnectingMessage)
        this.logger.debug(
          `Ignoring signaling request from ${message.payload.sourceIdentity}, at max peers`,
        )
        return
      }
    }

    const targetPeer = this.getOrCreatePeer(message.payload.sourceIdentity)
    this.addKnownPeerTo(targetPeer, messageSender)

    if (targetPeer.state.type !== 'DISCONNECTED' && targetPeer.state.connections.webRtc) {
      this.logger.debug(
        `Ignoring signaling request from ${targetPeer.displayName} because we already have a connection`,
      )
      return
    }

    this.initWebRtcConnection(messageSender, targetPeer, true)
  }

  /**
   * Handle a signal message relayed by another peer.
   * @param message An incoming Signal message from a peer.
   */
  private handleSignalMessage(messageSender: Peer, message: Signal) {
    // Forward the message if it's not destined for us
    if (message.payload.destinationIdentity !== this.localPeer.publicIdentity) {
      // Only forward it if the message was received from the same peer as it originated from
      if (message.payload.sourceIdentity !== messageSender.state.identity) {
        this.logger.debug(
          `not forwarding signal from ${
            messageSender.displayName
          } because the message's source identity (${
            message.payload.sourceIdentity
          }) doesn't match the sender's identity (${String(messageSender.state.identity)})`,
        )
        return
      }

      const destinationPeer = this.getPeer(message.payload.destinationIdentity)

      if (!destinationPeer) {
        this.logger.debug(
          'not forwarding signal from',
          messageSender.displayName,
          'due to unknown peer',
          message.payload.destinationIdentity,
        )
        return
      }

      this.sendTo(destinationPeer, message)
      return
    }

    // Ignore the request if we're at max peers and don't have an existing connection
    if (this.shouldRejectDisconnectedPeers()) {
      const peer = this.getPeer(message.payload.sourceIdentity)
      if (!peer || peer.state.type !== 'CONNECTED') {
        const disconnectingMessage: DisconnectingMessage = {
          type: InternalMessageType.disconnecting,
          payload: {
            sourceIdentity: this.localPeer.publicIdentity,
            destinationIdentity: message.payload.sourceIdentity,
            reason: DisconnectingReason.Congested,
            disconnectUntil: 1000 * 60 * 5,
          },
        }
        messageSender.send(disconnectingMessage)
        this.logger.debug(
          `Ignoring signaling request from ${message.payload.sourceIdentity}, at max peers`,
        )
        return
      }
    }

    // Get or create a WebRTC connection for the signaling peer.
    const signalingPeer = this.getOrCreatePeer(message.payload.sourceIdentity)
    this.addKnownPeerTo(signalingPeer, messageSender)

    let connection: WebRtcConnection

    if (
      signalingPeer.state.type === 'DISCONNECTED' ||
      signalingPeer.state.connections.webRtc == null
    ) {
      if (signalingPeer.state.identity == null) {
        this.logger.log('Peer must have an identity to begin signaling')
        return
      }

      if (
        !canInitiateWebRTC(signalingPeer.state.identity, message.payload.destinationIdentity)
      ) {
        this.logger.debug(
          'not handling signal message from',
          signalingPeer.name,
          'because source peer should have requested signaling',
        )
        return
      }

      connection = this.initWebRtcConnection(messageSender, signalingPeer, false)
    } else {
      connection = signalingPeer.state.connections.webRtc
    }

    // Try decrypting the message
    const result = this.localPeer.unboxMessage(
      message.payload.signal,
      message.payload.nonce,
      message.payload.sourceIdentity,
    )

    // Close the connection if decrypting fails
    if (result == null) {
      const error = `Failed to decrypt signaling data from ${signalingPeer.displayName}`
      this.logger.debug(error)
      connection.close(new NetworkError(error))
      return
    }

    // Try JSON.parsing the decrypted message
    let signalData: SignalData
    try {
      signalData = JSON.parse(result) as SignalData
    } catch {
      const error = `Failed to decode signaling data from ${signalingPeer.displayName}`
      this.logger.debug(error)
      connection.close(new NetworkError(error))
      return
    }

    // We have the signaling data, so pass it on to the connection
    connection.signal(signalData)
  }

  private handlePeerListMessage(peerList: PeerList, peer: Peer) {
    if (peer.state.type !== 'CONNECTED') {
      this.logger.warn('Should not handle the peer list message unless peer is connected')
      return
    }

    // Workers don't try connect to other peers, so if localPeer is a worker,
    // we can ignore this message
    if (this.localPeer.isWorker) {
      return
    }

    let changed = false

    const newPeerSet = peerList.payload.connectedPeers.reduce(
      (memo, peer) => {
        memo.set(peer.identity, peer)
        return memo
      },
      new Map<
        Identity,
        {
          identity: Identity
          name?: string
          address: string | null
          port: number | null
        }
      >(),
    )

    // Don't include the local peer in the peer graph
    newPeerSet.delete(this.localPeer.publicIdentity)

    // Remove peer edges that are no longer in the peer list.
    for (const [otherIdentity, otherPeer] of peer.knownPeers) {
      if (!newPeerSet.has(otherIdentity)) {
        peer.knownPeers.delete(otherIdentity)
        // Optimistically update the edges.
        // This could result in pinging back and forth if peers don't agree whether they're connected
        otherPeer.knownPeers.delete(peer.state.identity)
        // See if removing edges from either peer caused it to be disposable
        this.tryDisposePeer(peer)
        this.tryDisposePeer(otherPeer)
        changed = true
      }
    }

    // Add peer edges that are new to the peer list
    for (const newPeer of newPeerSet.values()) {
      if (!peer.knownPeers.has(newPeer.identity)) {
        const knownPeer = this.getOrCreatePeer(newPeer.identity)
        knownPeer.setWebSocketAddress(newPeer.address, newPeer.port)
        knownPeer.name = newPeer.name || null
        this.addKnownPeerTo(knownPeer, peer, false)
        changed = true
      }
    }

    if (changed) {
      peer.onKnownPeersChanged.emit()
    }
  }

  /**
   * This is used for adding a peer to a peers known list. It also handles adding it bi-directionally
   * and emits peer.onKnownPeersChanged by default.
   * @param peer The peer to put into `addTo's` knownPeers
   * @param addTo The peer to add `peer` to
   * @param emitKnownPeersChanged Set this to false if you are adding known peers in bulk and you know you want to emit this yourself
   */
  addKnownPeerTo(peer: Peer, addTo: Peer, emitKnownPeersChanged = true): void {
    if (!peer.state.identity || !addTo.state.identity) return
    if (peer.state.identity === addTo.state.identity) return

    if (!addTo.knownPeers.has(peer.state.identity)) {
      addTo.knownPeers.set(peer.state.identity, peer)

      if (emitKnownPeersChanged) {
        addTo.onKnownPeersChanged.emit()
      }
    }

    // Optimistically update the edges. This could result in pinging back and forth if peers don't agree whether they're connected
    if (!peer.knownPeers.has(addTo.state.identity)) {
      this.addKnownPeerTo(addTo, peer)
    }
  }
}
