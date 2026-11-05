// Real Windows SSH host lane: invoke-windows-host-cells.ps1 supplies HIVEWARD_RUN_SSH_WINDOWS_HOST=1 and HIVEWARD_SSH_WINDOWS_HOST_CELL.
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { SshConnection } from '../../ssh/connection/ssh-connection'
import {
  connectHostileHost,
  installHostileHostAppEnvironment
} from '../../ssh/hostile-host-test-support/ssh-hostile-host-test-harness'
import { resolveHivewarddRemoteContext } from '../install/hivewardd-remote-context'
import { proveWindowsStdioBridge } from '../../ssh/hivewardd-windows-stdio-bridge-test-cell'
import { deployHivewardd } from '../../ssh/hivewardd-remote-deploy'
import { hivewarddLivenessProbeCommand, parseHivewarddLiveness } from '../install/hivewardd-remote-launch'
import { hivewarddSlotDir, type HivewarddSlotOptions } from '../../ssh/hivewardd-recovery-slot'
import { decommissionRemoteHivewardd } from '../install/hivewardd-remote-decommission'
import { readHivewarddActivationRecord } from '../activation/hivewardd-activation-record-store'
import { gcOldHivewarddVersions } from '../install/hivewardd-remote-gc'
import { execHivewarddRemote } from '../install/hivewardd-remote-runtime-control'
import { hivewarddWindowsNodeCommandLine } from '../install/hivewardd-remote-windows-node'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'
import {
  isWindowsHivewarddCellId,
  readWindowsHostCellDescriptor,
  windowsHostSshTarget
} from '../../ssh/ssh-windows-host-cells'

const RUN = process.env.HIVEWARD_RUN_SSH_WINDOWS_HOST === '1'
const CELL_TIMEOUT_MS = 20 * 60_000

/** Host operations must avoid PowerShell hops regardless of sshd DefaultShell. */
function isHivewarddHostCommand(command: string): boolean {
  return /hivewardd-host-script-[0-9a-f]{16}\.js|[\\/]hivewardd\.js /u.test(command)
}

describe.runIf(RUN)('managed hivewardd on a Windows OpenSSH host', () => {
  let cleanupAppEnvironment: (() => void) | null = null

  beforeAll(() => {
    cleanupAppEnvironment = installHostileHostAppEnvironment()
  })

  afterAll(() => {
    cleanupAppEnvironment?.()
  })

  it(
    'deploys, serves, decommissions by request and exits',
    async () => {
      const descriptor = readWindowsHostCellDescriptor(process.env.HIVEWARD_SSH_WINDOWS_HOST_CELL ?? '')
      if (!isWindowsHivewarddCellId(descriptor.cell)) {
        throw new Error(`${descriptor.cell} is not a managed hivewardd cell`)
      }
      const sshTarget = windowsHostSshTarget(descriptor, randomUUID())
      let exec: MockInstance<SshConnection['exec']> | null = null
      const receipt: Record<string, unknown> = { cell: descriptor.cell, target: descriptor.target }
      let conn: SshConnection | null = null
      try {
        conn = await connectHostileHost(sshTarget)
        exec = vi.spyOn(SshConnection.prototype, 'exec')
        const context = await resolveHivewarddRemoteContext(sshTarget, conn)
        expect(context.host.os).toBe('win32')
        const options: HivewarddSlotOptions = {
          conn,
          host: context.host,
          remoteHome: context.remoteHome,
          nodePath: 'node',
          userDataDir: context.userDataDir,
          bindHost: '127.0.0.1',
          port: 0
        }
        const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
        const deployed = await deployHivewardd({
          ...options,
          target: context.serverTarget,
          census: idle,
          recountCensus: async () => idle,
          releaseIncumbentAdmission: async () => {}
        })
        receipt.deploy = deployed
        expect(deployed.outcome).toBe('installed-and-activated')
        const slotDir = hivewarddSlotDir(options, deployed.fullVersion)
        const liveness = async () =>
          parseHivewarddLiveness(
            await execHivewarddRemote(options, hivewarddLivenessProbeCommand(options.host, slotDir))
          )
        expect(await liveness()).toBe('LIVE')
        // Probe the native hiveward launcher installed inside the managed profile.
        const cli = joinRemotePath(options.host, context.userDataDir, 'cli', 'bin', 'hiveward.exe')
        const status = JSON.parse(
          await execHivewarddRemote(options, hivewarddWindowsNodeCommandLine(cli, ['status', '--json']))
        )
        receipt.cliStatus = status.result
        expect(status.result.runtime).toMatchObject({ reachable: true })
        expect(status.result.app.desktopWindowStatus).toBe('blocked')
        // This account blocks forwarding; verify the managed tunnel's stdio fallback.
        receipt.stdioBridge = await proveWindowsStdioBridge(conn, options.host, slotDir)
        expect(receipt.stdioBridge).toMatchObject({
          forwarding: 'refused',
          response: expect.stringMatching(/^HTTP\/1\.1 101/u)
        })
        const record = await readHivewarddActivationRecord(options)
        receipt.decommission = await decommissionRemoteHivewardd({
          ...options,
          record,
          census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
        })
        // Include the refusal detail because matcher diffs omit the message.
        expect(receipt.decommission, JSON.stringify(receipt.decommission)).toMatchObject({
          outcome: 'decommissioned',
          version: deployed.fullVersion
        })
        expect(await liveness()).toBe('DEAD')
        await gcOldHivewarddVersions({
          conn,
          host: options.host,
          remoteHome: options.remoteHome,
          currentDirAbsPath: slotDir,
          record: await readHivewarddActivationRecord(options)
        })
        expect(await liveness()).toBe('DEAD')

        const commands = exec.mock.calls.map(([command]) => String(command))
        const hivewarddCommands = commands.filter(isHivewarddHostCommand)
        receipt.hivewarddCommands = hivewarddCommands.length
        receipt.powershellCommands = commands.filter((command) =>
          /^powershell\.exe /iu.test(command)
        ).length
        expect(hivewarddCommands.length).toBeGreaterThan(0)
        for (const command of hivewarddCommands) {
          expect(command).not.toMatch(/EncodedCommand/u)
        }
        receipt.passed = true
      } finally {
        exec?.mockRestore()
        await conn?.disconnect().catch(() => {})
        writeFileSync(descriptor.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
      }
    },
    CELL_TIMEOUT_MS
  )
})
