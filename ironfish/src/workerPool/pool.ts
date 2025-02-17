/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IronfishNote, IronfishTransaction } from '../strategy'
import * as worker from './worker'
import { Worker } from 'worker_threads'
import type {
  CreateTransactionRequest,
  CreateMinersFeeRequest,
  OmitRequestId,
  TransactionFeeRequest,
  VerifyTransactionRequest,
  WorkerRequest,
  WorkerResponse,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from './messages'
import type { Side } from '../merkletree/merkletree'

/**
 * Manages the creation of worker threads and distribution of jobs to them.
 */
export class WorkerPool {
  private readonly resolvers: Map<number, (response: WorkerResponse) => void> = new Map<
    number,
    (response: WorkerResponse) => void
  >()
  private workers: Array<Worker> = []

  private _started = false
  public get started(): boolean {
    return this._started
  }

  private workerIndex = 0
  private lastRequestId = 0

  private sendRequest(request: Readonly<WorkerRequest>): Promise<WorkerResponse | null> {
    const requestId = this.lastRequestId++

    const requestMessage: Readonly<WorkerRequestMessage> = { requestId, body: request }

    if (this.workers.length === 0) {
      const response = worker.handleRequest(requestMessage)
      return Promise.resolve(response ? response.body : null)
    }

    return this.promisifyRequest(requestMessage)
  }

  /**
   * Send a request to the worker thread,
   * giving it an id and constructing a promise that can be resolved
   * when the worker thread has issued a response message.
   */
  private promisifyRequest(request: Readonly<WorkerRequestMessage>): Promise<WorkerResponse> {
    const promise: Promise<WorkerResponse> = new Promise((resolve) => {
      this.resolvers.set(request.requestId, (posted) => resolve(posted))
    })

    this.workerIndex = (this.workerIndex + 1) % this.workers.length
    this.workers[this.workerIndex].postMessage(request)

    return promise
  }

  private promisifyResponse(response: WorkerResponseMessage): void {
    const resolver = this.resolvers.get(response.requestId)
    if (resolver) {
      this.resolvers.delete(response.requestId)
      resolver(response.body)
    }
  }

  start(workers: number): WorkerPool {
    if (this.started) {
      return this
    }

    this._started = true

    // Works around different paths when run under ts-jest
    let dir = __dirname
    if (dir.includes('ironfish/src/workerPool')) {
      dir = dir.replace('ironfish/src/workerPool', 'ironfish/build/src/workerPool')
    }

    for (let i = 0; i < workers; i++) {
      const worker = new Worker(dir + '/worker.js')
      worker.on('message', (value) => this.promisifyResponse(value))
      this.workers.push(worker)
    }

    return this
  }

  async stop(): Promise<undefined> {
    await Promise.all(this.workers.map((w) => w.terminate()))
    this.workers = []
    this.resolvers.clear()
    this._started = false
    return
  }

  async createMinersFee(
    spendKey: string,
    amount: bigint,
    memo: string,
  ): Promise<IronfishTransaction> {
    const request: OmitRequestId<CreateMinersFeeRequest> = {
      type: 'createMinersFee',
      spendKey,
      amount,
      memo,
    }

    const response = await this.sendRequest(request)

    if (response === null || response.type !== request.type) {
      throw new Error('Response type must match request type')
    }

    return new IronfishTransaction(Buffer.from(response.serializedTransactionPosted), this)
  }

  async createTransaction(
    spendKey: string,
    transactionFee: bigint,
    spends: {
      note: IronfishNote
      treeSize: number
      rootHash: Buffer
      authPath: {
        side: Side
        hashOfSibling: Buffer
      }[]
    }[],
    receives: { publicAddress: string; amount: bigint; memo: string }[],
  ): Promise<IronfishTransaction> {
    const request: OmitRequestId<CreateTransactionRequest> = {
      type: 'createTransaction',
      spendKey,
      transactionFee,
      spends: spends.map((s) => ({
        ...s,
        note: s.note.serialize(),
      })),
      receives,
    }

    const response = await this.sendRequest(request)

    if (response === null || response.type !== request.type) {
      throw new Error('Response type must match request type')
    }

    return new IronfishTransaction(Buffer.from(response.serializedTransactionPosted), this)
  }

  async transactionFee(transaction: IronfishTransaction): Promise<bigint> {
    const request: OmitRequestId<TransactionFeeRequest> = {
      type: 'transactionFee',
      serializedTransactionPosted: transaction.serialize(),
    }

    const response = await this.sendRequest(request)

    if (response === null || response.type !== request.type) {
      throw new Error('Response type must match request type')
    }

    return response.transactionFee
  }

  async verify(transaction: IronfishTransaction): Promise<boolean> {
    const request: OmitRequestId<VerifyTransactionRequest> = {
      type: 'verify',
      serializedTransactionPosted: transaction.serialize(),
    }

    const response = await this.sendRequest(request)

    if (response === null || response.type !== request.type) {
      throw new Error('Response type must match request type')
    }

    return response.verified
  }
}
