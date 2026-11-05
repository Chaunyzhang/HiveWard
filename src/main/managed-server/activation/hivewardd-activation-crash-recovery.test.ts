import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import type * as RecordFile from '../install/hivewardd-remote-record-file'
import type * as InstallLock from '../install/remote-install-lock'
import type * as VersionedInstall from '../install/remote-versioned-install'
import type * as Crypto from 'node:crypto'

const uuid = vi.hoisted((): { fixed: string | null } => ({ fixed: null }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>()
  return { ...actual, randomUUID: () => uuid.fixed ?? actual.randomUUID() }
})

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

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { acquireInstallLock } from '../install/remote-install-lock'
import { writeAtomicHivewarddRemoteRecord } from '../install/hivewardd-remote-record-file'
import { deployHivewardd } from '../../ssh/hivewardd-remote-deploy'
import { rollbackHivewardd } from '../install/hivewardd-remote-rollback'
import { recoverInterruptedHivewarddActivation } from './hivewardd-activation-recovery'
import { wakeStoppedManagedHivewardd } from '../lifecycle/hivewardd-managed-wake'
import { planManagedHivewarddAutoUpdate } from '../lifecycle/hivewardd-managed-update-decision'
import { parseHivewarddActivationRecord } from './hivewardd-activation-record'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'
import {
  BUILD_HASH,
  FakeHivewarddHost,
  NEW,
  OLD,
  type CrashMode
} from './hivewardd-activation-host-test-harness'

let host = new FakeHivewarddHost()

const slot = {
  conn: Object.create(null),
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
const census = {
  liveSessions: 0,
  startedSinceActivation: 0,
  daemonProtocolVersion: 3
}

const deploy = (): Promise<unknown> =>
  deployHivewardd({
    ...slot,
    localHivewarddDir: '/local/out/hivewardd',
    target: 'linux-x64-glibc',
    census,
    recountCensus: async () => census,
    releaseIncumbentAdmission: async () => {}
  })
const deployFromNewerApp = (): Promise<unknown> =>
  deployHivewardd({
    ...slot,
    localHivewarddDir: '/local/out/hivewardd',
    target: 'linux-x64-glibc',
    census,
    recountCensus: async () => census,
    releaseIncumbentAdmission: async () => {},
    appVersion: '1.9.0'
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
    targetDaemonProtocol: {
      protocolVersion: 3,
      previousProtocolVersions: [1, 2]
    }
  })

beforeEach(() => {
  installFakeAppEnvironment({
    getVersion: () => '1.0.0',
    getPath: () => '/tmp/hiveward-test-profile'
  })
  vi.clearAllMocks()
  uuid.fixed = null
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
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

function failCandidateReadinessGate(): void {
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
    const answer = host.exec(command)
    return command.includes(`hivewardd-${NEW}/`)
      ? answer.replace('"state":"live"', '"state":"absent"')
      : answer
  })
}

function expectExactlyTheRecordedSlot(): void {
  const active = host.activeVersion()
  expect([...host.alive]).toEqual(active ? [active] : [])
  expect(host.isReadableBy(active)).toBe(true)
  expect(host.journal).toBeNull()
  expect(host.fence).toBe(false)
}

function expectNoSlotOrSnapshotRemoved(): void {
  const removals = host.commands
    .filter((command) => /\brm -r?f\b/u.test(command))
    // A failed capture's partial archive is not a usable snapshot.
    .map((command) => command.replace(/rm -f '[^']*\/state\.tar'\.partial/gu, ''))
  for (const command of removals) {
    // Consumed request files may be removed; slot directories must remain.
    expect(command).not.toMatch(/rm -r?f '[^']*\/hivewardd-\d[^'/]*\/?'/u)
    expect(command).not.toMatch(/rm -r?f '[^']*hivewardd-state-snapshots/u)
  }
}

function countMutations(
  scenario: () => FakeHivewarddHost,
  run: () => Promise<unknown>
): Promise<number> {
  host = scenario()
  return run().then(() => host.mutations)
}

const scenarios: [string, () => FakeHivewarddHost, () => Promise<unknown>][] = [
  ['an update over an incumbent', FakeHivewarddHost.deployedOld, deploy],
  ['a first activation', () => new FakeHivewarddHost(), deploy],
  ['a rollback', FakeHivewarddHost.activatedNew, rollback]
]

describe.each(scenarios)('%s interrupted at every mutation', (_name, scenario, run) => {
  it('completes cleanly when nothing interrupts it', async () => {
    host = scenario()
    await run()
    expectExactlyTheRecordedSlot()
    expect(host.activeVersion()).toBe(run === rollback ? OLD : NEW)
  })

  it.each<CrashMode>(['before', 'after'])(
    'recovers to exactly one recorded slot when the host answer is lost %s applying it',
    async (mode) => {
      const total = await countMutations(scenario, run)
      expect(total).toBeGreaterThan(3)
      for (let crashAt = 1; crashAt <= total; crashAt += 1) {
        host = scenario()
        host.crashAt = crashAt
        host.crashMode = mode
        await run().catch(() => undefined)
        host.crashAt = null
        const result = await recoverInterruptedHivewarddActivation({
          ...slot,
          acceptChangedState: true
        })
        expect(['recovered', 'none'], `mutation ${crashAt}`).toContain(result.outcome)
        expectExactlyTheRecordedSlot()
        expectNoSlotOrSnapshotRemoved()
      }
    }
  )
})

describe('the rollback terminal barrier', () => {
  it.each(['live', 'unverifiable'] as const)(
    'restores nothing and restarts the newer build when the stop finds %s work after the census',
    async (retirement) => {
      host = FakeHivewarddHost.activatedNew()
      host.retirement = retirement
      const before = host.data
      await expect(rollback()).resolves.toMatchObject({
        outcome: 'refused',
        code: 'hivewardd_rollback_terminals_at_stop'
      })
      expect(host.data).toBe(before)
      expect(host.activeVersion()).toBe(NEW)
      expect(host.alive.has(NEW)).toBe(true)
      expect(host.journal).toBeNull()
      expect(host.fence).toBe(false)
    }
  )
})

/** Model an older desktop reconnecting after recovery committed a newer app's update. */
function olderDesktopPlan(): ReturnType<typeof planManagedHivewarddAutoUpdate> {
  const read = parseHivewarddActivationRecord(host.record)
  if (read.state !== 'ok') {
    throw new Error(`record is ${read.state}`)
  }
  return planManagedHivewarddAutoUpdate({
    record: read.record,
    candidateVersion: OLD,
    appVersion: '1.5.0',
    failedBefore: false
  })
}

describe('recovery refusals keep the fence', () => {
  async function interruptedAfterCandidateLaunch(
    run: () => Promise<unknown> = deploy
  ): Promise<void> {
    host = FakeHivewarddHost.deployedOld()
    const total = await countMutations(FakeHivewarddHost.deployedOld, run)
    host = FakeHivewarddHost.deployedOld()
    // Crash before candidate-ready journal, activation record and fence release complete.
    host.crashAt = total - 2
    host.crashMode = 'before'
    await run().catch(() => undefined)
    host.crashAt = null
    expect(host.alive.has(NEW)).toBe(true)
  }

  it('commits the candidate an interrupted run left serving, without restoring state', async () => {
    await interruptedAfterCandidateLaunch()
    const data = host.data
    const result = await recoverInterruptedHivewarddActivation(slot)
    expect(result).toMatchObject({
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: NEW
    })
    expect(host.data).toBe(data)
    expect(host.commands.filter((command) => command.includes('kill -TERM'))).toHaveLength(1)
    expectExactlyTheRecordedSlot()
    expect(host.record).toContain(`"previous": "${OLD}"`)
  })

  it('skips its reads only when a connect just saw no journal and an open fence', async () => {
    await interruptedAfterCandidateLaunch()
    const before = host.commands.length
    expect(
      await recoverInterruptedHivewarddActivation(slot, { transactionAbsent: true, fenceOpen: true })
    ).toEqual({ outcome: 'none' })
    expect(host.commands).toHaveLength(before)
    // Any other answer reads the host as before, and so finds the interrupted run.
    const result = await recoverInterruptedHivewarddActivation(slot, {
      transactionAbsent: false,
      fenceOpen: true
    })
    expect(result).toMatchObject({ outcome: 'recovered', resolution: 'committed' })
  })

  it('skips the deploy fence only for a same-version WSL deploy whose caller re-checks', async () => {
    const sameVersion = { sameVersionFencedByCaller: true }
    host = FakeHivewarddHost.activatedNew()
    const deployWith = (extra: { sameVersionFencedByCaller?: boolean }) =>
      deployHivewardd({
        ...slot,
        localHivewarddDir: '/local/out/hivewardd',
        target: 'linux-x64-glibc',
        census,
        recountCensus: async () => census,
        releaseIncumbentAdmission: async () => {},
        ...extra
      })
    expect(await deployWith(sameVersion)).toEqual({ outcome: 'already-active', fullVersion: NEW })
    expect(acquireInstallLock).not.toHaveBeenCalled()
    // Without the flag, or on a host running another version, the deploy fences as before.
    expect(await deployWith({})).toMatchObject({ outcome: 'already-active' })
    expect(acquireInstallLock).toHaveBeenCalledOnce()
    host = FakeHivewarddHost.deployedOld()
    await deployWith(sameVersion)
    expect(acquireInstallLock).toHaveBeenCalledTimes(2)
  })

  it('relaunches and commits that candidate after a host reboot left nothing running', async () => {
    await interruptedAfterCandidateLaunch()
    host.alive.clear()
    const result = await recoverInterruptedHivewarddActivation(slot)
    expect(result).toMatchObject({
      outcome: 'recovered',
      resolution: 'committed'
    })
    expectExactlyTheRecordedSlot()
    expect(host.activeVersion()).toBe(NEW)
  })

  it('stamps the committed record with the app that started the update, not none', async () => {
    await interruptedAfterCandidateLaunch(deployFromNewerApp)
    host.alive.clear()
    expect(await recoverInterruptedHivewarddActivation(slot)).toMatchObject({
      outcome: 'recovered',
      resolution: 'committed'
    })
    expect(host.record).toContain('"activeAppVersion": "1.9.0"')
    expect(olderDesktopPlan()).toEqual({
      action: 'skip',
      reason: 'host-newer'
    })
  })

  function dropCandidateAppVersion(): void {
    const journal = JSON.parse(host.journal ?? 'null')
    delete journal.candidateAppVersion
    host.journal = JSON.stringify(journal)
  }

  it('neither commits nor stops a serving candidate a journal too old to name its app left', async () => {
    await interruptedAfterCandidateLaunch(deployFromNewerApp)
    dropCandidateAppVersion()
    const data = host.data
    expect(await recoverInterruptedHivewarddActivation(slot)).toMatchObject({
      outcome: 'refused',
      verdict: 'live',
      code: 'hivewardd_recovery_changed_state'
    })
    expect([...host.alive]).toEqual([NEW])
    expect(host.data).toBe(data)
    expect(host.record).not.toContain(`"active": "${NEW}"`)
    expect(host.fence).toBe(true)

    await expect(
      recoverInterruptedHivewarddActivation({ ...slot, acceptChangedState: true })
    ).resolves.toMatchObject({ outcome: 'recovered', resolution: 'restored-incumbent' })
    expect(host.fence).toBe(false)
    expectExactlyTheRecordedSlot()
    expect(host.activeVersion()).toBe(OLD)
  })

  it('keeps changed state, unverifiable, until an operator accepts restoring over it', async () => {
    await interruptedAfterCandidateLaunch()
    failCandidateReadinessGate()
    const result = await recoverInterruptedHivewarddActivation(slot)
    expect(result).toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'hivewardd_recovery_changed_state'
    })
    expect(host.fence).toBe(true)
    expect(host.journal).not.toBeNull()
    expect(host.alive.size).toBe(0)

    // Refused recovery marks its fence ownerless so an accepting retry need not await staleness.
    await expect(
      recoverInterruptedHivewarddActivation({ ...slot, acceptChangedState: true })
    ).resolves.toMatchObject({
      outcome: 'recovered',
      resolution: 'restored-incumbent'
    })
    expect(host.journal).toBeNull()
    expect(host.fence).toBe(false)
    expectExactlyTheRecordedSlot()
  })

  it('never treats an unverifiable incumbent as exited', async () => {
    host = FakeHivewarddHost.deployedOld()
    host.crashAt = 3
    await deploy().catch(() => undefined)
    host.crashAt = null
    host.pidFiles.delete(OLD)
    host.alive.delete(OLD)
    const result = await recoverInterruptedHivewarddActivation({ ...slot })
    expect(result).toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable'
    })
    expect(host.fence).toBe(true)
    expect(host.alive.size).toBe(0)
  })

  it('reports a fresh fence as pending instead of taking it over', async () => {
    host = FakeHivewarddHost.deployedOld()
    host.crashAt = 3
    await deploy().catch(() => undefined)
    host.crashAt = null
    const journal = host.journal
    expect(journal).not.toBeNull()
    const { RemoteInstallLockBusyError } = await vi.importActual<typeof InstallLock>(
      '../install/remote-install-lock'
    )
    vi.mocked(acquireInstallLock).mockRejectedValueOnce(new RemoteInstallLockBusyError('/l', 0))
    expect(await recoverInterruptedHivewarddActivation({ ...slot })).toMatchObject({
      outcome: 'pending'
    })
    expect(host.journal).toBe(journal)
  })

  it('keeps a journal this client cannot read', async () => {
    host = FakeHivewarddHost.deployedOld()
    host.journal = JSON.stringify({
      schemaVersion: 1,
      operation: 'decommission'
    })
    host.fence = true
    expect(await recoverInterruptedHivewarddActivation({ ...slot })).toMatchObject({
      outcome: 'refused',
      code: 'hivewardd_recovery_unverifiable'
    })
    expect(host.fence).toBe(true)
  })

  it('drops a fence whose release was cut short after the journal went', async () => {
    host = FakeHivewarddHost.deployedOld()
    host.fence = true
    expect(await recoverInterruptedHivewarddActivation({ ...slot })).toEqual({
      outcome: 'none'
    })
    expect(host.fence).toBe(false)
  })
})

describe('a wake over an update its client abandoned', () => {
  const wakeSlot = {
    ...slot,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked; the wake reads only the target id.
    conn: { getTarget: () => ({ id: 'ssh-1' }) } as unknown as HivewarddHostTransport
  }

  async function abandonedAfterCandidateLaunch(
    run: () => Promise<unknown> = deploy
  ): Promise<void> {
    const total = await countMutations(FakeHivewarddHost.deployedOld, run)
    host = FakeHivewarddHost.deployedOld()
    host.crashAt = total - 2
    await run().catch(() => undefined)
    host.crashAt = null
    // Reboot removes processes while retaining the recovery journal and fence.
    host.alive.clear()
    expect(host.journal).not.toBeNull()
    expect(host.fence).toBe(true)
  }

  it('finishes the update and serves the candidate instead of staying fenced', async () => {
    await abandonedAfterCandidateLaunch()
    expect(await wakeStoppedManagedHivewardd(wakeSlot)).toMatchObject({
      outcome: 'started'
    })
    expectExactlyTheRecordedSlot()
    expect(host.activeVersion()).toBe(NEW)
  })

  it('keeps the host-newer guard, so an older desktop does not downgrade it', async () => {
    await abandonedAfterCandidateLaunch(deployFromNewerApp)
    expect(await wakeStoppedManagedHivewardd(wakeSlot)).toMatchObject({
      outcome: 'started'
    })
    expect(host.record).toContain('"activeAppVersion": "1.9.0"')
    expect(olderDesktopPlan()).toEqual({
      action: 'skip',
      reason: 'host-newer'
    })
  })

  it('leaves a fence a run may still hold to that run', async () => {
    await abandonedAfterCandidateLaunch()
    host.fenceFresh = true
    expect(await wakeStoppedManagedHivewardd(wakeSlot)).toEqual({
      outcome: 'fenced'
    })
    expect(host.alive.size).toBe(0)
    expect(host.journal).not.toBeNull()
  })

  it('leaves serving a candidate whose too-old journal it cannot commit', async () => {
    await abandonedAfterCandidateLaunch(deployFromNewerApp)
    host.alive.add(NEW)
    const journal = JSON.parse(host.journal ?? 'null')
    delete journal.candidateAppVersion
    host.journal = JSON.stringify(journal)
    expect(await wakeStoppedManagedHivewardd(wakeSlot)).toMatchObject({
      outcome: 'recovery-refused'
    })
    expect([...host.alive]).toEqual([NEW])
    expect(host.fence).toBe(true)
  })

  it('reports why when only an operator can finish it', async () => {
    await abandonedAfterCandidateLaunch()
    failCandidateReadinessGate()
    expect(await wakeStoppedManagedHivewardd(wakeSlot)).toMatchObject({
      outcome: 'recovery-refused',
      reason: expect.stringContaining('changed profile state')
    })
    expect(host.fence).toBe(true)
  })
})

describe('every launch is a managed one', () => {
  it.each(scenarios)(
    '%s starts hivewardd with idle exit and its activation fence',
    async (_n, scenario, run) => {
      host = scenario()
      await run()
      const launches = host.commands.filter((command) => command.includes('nohup'))
      expect(launches.length).toBeGreaterThan(0)
      for (const launch of launches) {
        expect(launch).toContain(
          "HIVEWARD_HIVEWARDD_MANAGED_ACTIVATION_ROOT='/home/u/.hiveward-remote/.hivewardd-activation-transaction'"
        )
      }
    }
  )
})

// Tokens containing -cf must not make the fake host misclassify restore as capture.
it('restores the pre-activation snapshot under a fence token that contains a tar flag', async () => {
  uuid.fixed = '00000000-cf00-4000-8000-000000000000'
  host = FakeHivewarddHost.activatedNew()
  await rollback()
  expect(host.activeVersion()).toBe(OLD)
  expect(host.commands.filter((command) => command.includes('nohup')).length).toBeGreaterThan(0)
})
