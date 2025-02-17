/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { DataDirFlag, DataDirFlagKey, VerboseFlag, VerboseFlagKey } from '../flags'
import { IronfishCommand } from '../command'
import { spawn } from 'child_process'
import { v4 as uuid } from 'uuid'
import cli from 'cli-ux'
import fsAsync from 'fs/promises'
import os from 'os'
import path from 'path'
import { FileUtils } from 'ironfish'

export default class Backup extends IronfishCommand {
  static hidden = true
  static description = 'Zip and upload your datadir to an S3 bucket'

  static flags = {
    [VerboseFlagKey]: VerboseFlag,
    [DataDirFlagKey]: DataDirFlag,
  }

  static args = [
    {
      name: 'bucket',
      required: true,
      description: 'the S3 bucket to upload to',
    },
  ]

  async start(): Promise<void> {
    const { args } = this.parse(Backup)
    const bucket = (args.bucket as string).trim()

    let id = uuid().slice(0, 5)
    const name = this.sdk.config.get('nodeName')
    if (name) id = `${name}.${id}`

    const source = this.sdk.config.dataDir
    const destDir = await fsAsync.mkdtemp(path.join(os.tmpdir(), `ironfish.backup`))
    const dest = path.join(destDir, `node.${id}.tar.gz`)

    this.log(`Zipping\n    SRC ${source}\n    DST ${dest}\n`)
    cli.action.start(`Zipping ${source}`)

    await this.zipDir(source, dest)

    const stat = await fsAsync.stat(dest)
    cli.action.stop(`done (${FileUtils.formatFileSize(stat.size)})`)

    cli.action.start(`Uploading to ${bucket}`)
    await this.uploadToS3(dest, bucket)
    cli.action.start(`done`)
  }

  zipDir(source: string, dest: string): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      const sourceDir = path.dirname(source)
      const sourceFile = path.basename(source)

      const process = spawn('tar', ['-zcvf', dest, '-C', sourceDir, sourceFile])
      process.on('exit', (code) => resolve(code))
      process.on('error', (error) => reject(error))
    })
  }

  uploadToS3(dest: string, bucket: string): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      const date = new Date().toISOString()
      const host = `${bucket}.s3.amazonaws.com`
      const file = path.basename(dest)
      const contentType = 'application/x-compressed-tar'
      const acl = 'bucket-owner-full-control'

      const process = spawn(
        `curl`,
        [
          '-X',
          `PUT`,
          `-T`,
          `${dest}`,
          `-H`,
          `Host: ${host}`,
          `-H`,
          `Date: ${date}`,
          `-H`,
          `Content-Type: ${contentType}`,
          `-H`,
          `x-amz-acl: ${acl}`,
          `https://${host}/${file}`,
        ],
        { stdio: 'inherit' },
      )

      process.on('message', (m) => this.log(String(m)))
      process.on('exit', (code) => resolve(code))
      process.on('error', (error) => reject(error))
    })
  }
}
