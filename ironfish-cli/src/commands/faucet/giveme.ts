/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import cli from 'cli-ux'
import { RequestError } from 'ironfish'
import { IronfishCommand } from '../../command'
import { RemoteFlags } from '../../flags'
import { ONE_FISH_IMAGE, TWO_FISH_IMAGE } from '../../images'

export class GiveMeCommand extends IronfishCommand {
  static description = `Receive coins from the Iron Fish official Faucet`

  static flags = {
    ...RemoteFlags,
  }

  async start(): Promise<void> {
    this.log(`${ONE_FISH_IMAGE}

Receive funds, check your balance and send money.

Thanks for contributing to Iron Fish!
`)

    await this.sdk.client.connect()

    const email = (await cli.prompt('Enter your email to stay updated with Iron Fish', {
      required: false,
    })) as string

    // Create an account if one is not set
    const response = await this.sdk.client.getDefaultAccount()
    let accountName = response.content.account?.name

    if (!accountName) {
      this.log(`You don't have a default account set up yet. Let's create one first!`)
      accountName =
        ((await cli.prompt('Please enter the name of your new Iron Fish account', {
          required: false,
        })) as string) || 'default'

      await this.sdk.client.createAccount({ name: accountName, default: true })
    }

    cli.action.start('Collecting your funds', 'Sending a request to the Iron Fish network', {
      stdout: true,
    })
    try {
      await this.sdk.client.giveMeFaucet({
        accountName,
        email,
      })
      cli.action.stop('Success')
    } catch (error: unknown) {
      cli.action.stop('Unfortunately, the faucet request failed. Please try again later.')
      if (error instanceof RequestError) {
        this.log(error.message)
      }
      this.exit(1)
    }

    this.log(
      `

${TWO_FISH_IMAGE}

Congratulations! The Iron Fish Faucet just added your request to the queue!
It will be processed within the next hour and $IRON will be sent directly to your account.

Check your balance by running:
- ironfish accounts:balance

Learn how to send a transaction by running:
- ironfish accounts:pay --help
`,
    )
  }
}
