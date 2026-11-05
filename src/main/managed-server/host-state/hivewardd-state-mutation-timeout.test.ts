// Exercise fake-host lifecycle recovery while channel timeout leaves mutation running under the host lock.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import type * as RecordFile from '../install/hivewardd-remote-record-file'
import type * as InstallLock from '../install/remote-install-lock'
import type * as VersionedInstall from '../install/remote-versioned-install'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('../../../shared/shell-argument-quoting', () => ({
  quotePosixShell: (s: string) => `'${s}'`
}))
vi.mock('../install/remote-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn()
}))
vi.mock('../install/hivewardd-remote-record-file', async (importOriginal) => ({
  ...(await importOriginal<typeof RecordFile>()),
  writeAtomicHivewarddRemoteRecord: vi.fn()
}))
vi.mock('../install/remote-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<typeof VersionedInstall>()),
  readLocalFullVersion: () => '0.2.0+bb01'
}))
vi.mock('../install/hivewardd-remote-install', () => ({ installHivewarddBundle: vi.fn() }))
vi.mock('../install/hivewardd-remote-preflight', () => ({
  preflightInstalledHivewardd: vi.fn(async () => ({}))
}))
vi.mock('../../ssh/hivewardd-local-build-hash', () => ({
  computeLocalHivewarddBuildHash: () => 'abc123def4567890'
}))

import {
  execCommand,
  SSH_EXEC_TIMEOUT_CODE,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { acquireInstallLock } from '../install/remote-install-lock'
import { writeAtomicHivewarddRemoteRecord } from '../install/hivewardd-remote-record-file'
import { deployHivewardd } from '../../ssh/hivewardd-remote-deploy'
import { rollbackHivewardd } from '../install/hivewardd-remote-rollback'
import { recoverInterruptedHivewarddActivation } from '../activation/hivewardd-activation-recovery'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  BUILD_HASH,
  FakeHivewarddHost,
  NEW,
  OLD
} from '../activation/hivewardd-activation-host-test-harness'
import { isSnapshotCaptureCommand } from '../../ssh/hivewardd-snapshot-capture-command'
import { unusedHivewarddHostTransport } from '../../ssh/unused-host-transport.test-fixture'

let host = new FakeHivewarddHost()
type StateMutation = 'capture' | 'restore'
let slow: StateMutation | null = null
let running = false

const slot = {
  conn: unusedHivewarddHostTransport(),
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/u',
  nodePath: '/usr/bin/node',
  userDataDir: '/home/u/.hiveward',
  bindHost: '127.0.0.1',
  port: 7777,
  readinessTimeoutMs: 50,
  sleep: async () => {},
  now: () => new Date('2026-02-02T00:00:00.000Z')
}
const census = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 }
const deploy = (): Promise<unknown> =>
  deployHivewardd({
    ...slot,
    localHivewarddDir: '/local/out/hivewardd',
    target: 'linux-x64-glibc',
    census,
    recountCensus: async () => census,
    releaseIncumbentAdmission: async () => {}
  })
const rollback = (): Promise<unknown> =>
  rollbackHivewardd({
    ...slot,
    record: FakeHivewarddHost.newRecord(),
    census,
    recountCensus: async () => ({
      liveSessions: 0,
      startedSinceActivation: 0,
      daemonProtocolVersion: 3
    }),
    releaseIncumbentAdmission: async () => {},
    targetBuildHash: BUILD_HASH,
    targetDaemonProtocol: { protocolVersion: 3, previousProtocolVersions: [1, 2] }
  })

function stateMutation(command: string): StateMutation | null {
  if (!command.includes('hivewardd-state-snapshots/')) {
    return null
  }
  if (command.includes('.hivewardd-state-restore-stage')) {
    return 'restore'
  }
  return isSnapshotCaptureCommand(command) ? 'capture' : null
}

/** Acknowledged SSH channel close still leaves remote command termination unproven. */
function confirmedTimeout(): Error {
  return Object.assign(new Error('Command timed out after 30s'), {
    code: SSH_EXEC_TIMEOUT_CODE,
    sshChannelCloseConfirmed: true
  })
}

async function exec(command: string): Promise<string> {
  const kind = stateMutation(command)
  if (kind && running && command.includes('hivewardd-state-mutation.lock')) {
    return 'STATE_MUTATION_BUSY\n'
  }
  if (kind && kind === slow) {
    slow = null
    running = true
    // The host completes work even though the client stopped observing it.
    host.exec(command)
    throw confirmedTimeout()
  }
  return host.exec(command)
}

const count = (kind: StateMutation): number =>
  host.commands.filter((command) => stateMutation(command) === kind).length
const launchedAfter = (kind: StateMutation): boolean => {
  const first = host.commands.findIndex((command) => stateMutation(command) === kind)
  return host.commands.slice(first + 1).some((command) => command.includes('nohup'))
}
const orphanedFence = (): boolean =>
  host.commands.some((command) => command.startsWith('touch -m -t 200001010000'))

beforeEach(() => {
  vi.clearAllMocks()
  slow = null
  running = false
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => exec(command))
  vi.mocked(acquireInstallLock).mockImplementation(async (_conn, dir, _host, options) => {
    if (!host.acquireFence(options)) {
      const { RemoteInstallLockBusyError } = await vi.importActual<typeof InstallLock>(
        '../install/remote-install-lock'
      )
      throw new RemoteInstallLockBusyError(dir, 0)
    }
  })
  vi.mocked(writeAtomicHivewarddRemoteRecord).mockImplementation(async (_target, path, contents) =>
    host.write(path, contents)
  )
})

describe('a state mutation that outlives the client’s wait', () => {
  it('stops a rollback before a rescue restore or a launch can follow it', async () => {
    host = FakeHivewarddHost.activatedNew()
    slow = 'restore'
    const error = await rollback().catch((caught: unknown) => caught)
    expect(isUnconfirmedSshCommandTermination(error)).toBe(true)
    expect(count('restore')).toBe(1)
    expect(launchedAfter('restore')).toBe(false)
    expect(host.fence).toBe(true)
    expect(host.journal).not.toBeNull()
    expect(orphanedFence()).toBe(false)
  })

  it('keeps recovery’s fence fresh, so the next recover waits instead of restoring again', async () => {
    host = FakeHivewarddHost.deployedOld()
    await deploy()
    const total = host.mutations
    // Crash after launch but before journal, record and release complete.
    host = FakeHivewarddHost.deployedOld()
    host.crashAt = total - 2
    await deploy().catch(() => undefined)
    host.crashAt = null
    expect(host.alive.has(NEW)).toBe(true)
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      const answer = await exec(command)
      return command.includes(`hivewardd-${NEW}/`)
        ? answer.replace('"state":"live"', '"state":"absent"')
        : answer
    })
    slow = 'restore'
    const first = await recoverInterruptedHivewarddActivation({ ...slot, acceptChangedState: true })
    expect(first).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expect(orphanedFence()).toBe(false)
    expect(count('restore')).toBe(1)

    const second = await recoverInterruptedHivewarddActivation({ ...slot, acceptChangedState: true })
    expect(second).toMatchObject({ outcome: 'pending' })
    expect(count('restore')).toBe(1)
    expect(host.alive.size).toBe(0)
  })

  it('never restarts the incumbent beside a snapshot capture that is still copying', async () => {
    host = FakeHivewarddHost.deployedOld()
    slow = 'capture'
    const error = await deploy().catch((caught: unknown) => caught)
    expect(isUnconfirmedSshCommandTermination(error)).toBe(true)
    expect(launchedAfter('capture')).toBe(false)
    expect(host.alive.has(OLD)).toBe(false)
    expect(host.alive.has(NEW)).toBe(false)
    expect(host.fence).toBe(true)
    expect(orphanedFence()).toBe(false)
  })
})
