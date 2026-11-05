import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HIVEWARDD_UPDATE_ADMISSION_STOP_BY_MS } from '../../../shared/hivewardd-terminal-census'
import type * as RecordFile from './hivewardd-remote-record-file'
import type * as InstallLock from './remote-install-lock'
import type * as TerminalBarrier from '../lifecycle/hivewardd-rollback-terminal-barrier'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('../../../shared/shell-argument-quoting', () => ({
  quotePosixShell: (s: string) => `'${s}'`
}))
vi.mock('./remote-install-transfers', () => ({
  writeRemoteInstallFile: vi.fn().mockResolvedValue(undefined),
  uploadRemoteInstallDirectory: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./remote-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./hivewardd-remote-record-file', async (importOriginal) => ({
  ...(await importOriginal<typeof RecordFile>()),
  writeAtomicHivewarddRemoteRecord: vi.fn().mockResolvedValue(undefined)
}))

const barrier = vi.hoisted(() => {
  const state: { log: string[] | null; state: 'retired' | 'unproven' | 'withdrawn' } = {
    log: null,
    state: 'retired'
  }
  return state
})
// The real stop/barrier path is covered by hivewardd-activation-crash-recovery.test.ts.
vi.mock('../lifecycle/hivewardd-rollback-terminal-barrier', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalBarrier>()),
  readHivewarddRollbackBarrierTarget: async (_options: unknown, version: string) => ({
    state: 'ready',
    context: {
      version,
      runtimeId: 'r1',
      instance: { pid: 1, startedAtMs: 1, nonce: 'n', lockPath: '/l' }
    }
  }),
  stopIncumbentBehindTerminalBarrier: async (
    _options: unknown,
    _id: string,
    context: { version: string }
  ) => {
    barrier.log?.push(`stop:${context.version}`)
    if (barrier.state === 'withdrawn') {
      return { state: 'withdrawn', reason: 'The stop was cancelled before hivewardd acted on it.' }
    }
    return barrier.state === 'retired'
      ? { state: 'retired' }
      : { state: 'unproven', reason: 'A terminal started after the census.' }
  }
}))

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { writeAtomicHivewarddRemoteRecord } from './hivewardd-remote-record-file'
import { rollbackHivewardd, type HivewarddRollbackOptions } from './hivewardd-remote-rollback'
import {
  emptyHivewarddActivationRecord,
  type HivewarddActivationRecord
} from '../activation/hivewardd-activation-record'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { isReadinessRead } from '../activation/hivewardd-activation-host-test-harness'
import { isSnapshotCaptureCommand } from '../../ssh/hivewardd-snapshot-capture-command'

const mockExec = vi.mocked(execCommand)
const ACTIVE = '0.2.0+bb01'
const TARGET = '0.1.0+aa01'
const BUILD_HASH = 'abc123def4567890'

function record(overrides: Partial<HivewarddActivationRecord> = {}): HivewarddActivationRecord {
  return {
    ...emptyHivewarddActivationRecord(),
    active: ACTIVE,
    previous: TARGET,
    activatedAt: '2026-01-01T00:00:00.000Z',
    snapshot: {
      dirName: 'pre-0.2.0+bb01-1000',
      takenBeforeVersion: ACTIVE,
      readableByVersion: TARGET,
      takenAt: '2026-01-01T00:00:00.000Z'
    },
    ...overrides
  }
}

function readyLine(version: string): string {
  return JSON.stringify({
    type: 'hiveward_server_ready',
    schemaVersion: 1,
    runtimeId: 'r1',
    boundEndpoint: 'ws://127.0.0.1:7777',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
    health: {
      buildHash: BUILD_HASH,
      buildVersion: version,
      nodeVersion: '20.11.0',
      nodeAbi: '115',
      platform: 'linux',
      arch: 'x64',
      pid: 1,
      terminalDaemon: {
        state: 'live',
        ownsFreshSessions: true,
        pid: 2,
        buildVersion: version,
        entryPath: '/x/daemon-entry.js',
        protocolVersion: 3,
        selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 5 }
      }
    }
  })
}

type HostOverrides = {
  restores?: string[]
  readinessAtMs?: number
  targetReady?: boolean
  snapshot?: string
  comparison?: string
}

function scriptHost(log: string[], overrides: HostOverrides = {}): void {
  barrier.log = log
  barrier.state = 'retired'
  const restores = [...(overrides.restores ?? [])]
  mockExec.mockImplementation(async (_conn, command: string) => {
    const text = String(command)
    if (text.startsWith('tail -c')) {
      return text.includes(TARGET) ? 'hivewardd: listen EADDRINUSE 127.0.0.1\n' : ''
    }
    if (text.includes('__HIVEWARDD_RECORD_PRESENT__')) {
      return text.includes('transaction.json')
        ? '__HIVEWARDD_RECORD_ABSENT__\n'
        : `__HIVEWARDD_RECORD_PRESENT__\n${JSON.stringify(record())}`
    }
    if (text.includes('__HIVEWARDD_BUILD_HASH__')) {
      return `__HIVEWARDD_BUILD_HASH__ ${BUILD_HASH}\n`
    }
    if (text.includes('echo PRESENT')) {
      return overrides.snapshot ?? 'PRESENT'
    }
    if (text.includes('stat -c %Y')) {
      return 'UNKNOWN'
    }
    if (text.includes('kill -TERM')) {
      log.push(`stop:${text.includes(ACTIVE) ? ACTIVE : TARGET}`)
      return 'STOPPED'
    }
    if (text.includes('verdict=UNCHANGED')) {
      log.push('compare')
      return overrides.comparison ?? 'CHANGED'
    }
    if (isSnapshotCaptureCommand(text)) {
      log.push('rescue')
      return 'CAPTURED'
    }
    if (text.includes('tar -C') && text.includes('-xf')) {
      log.push(text.includes('rollback-rescue-') ? 'restore-rescue' : 'restore')
      return restores.shift() ?? 'RESTORED'
    }
    if (text.includes('nohup')) {
      log.push(`launch:${text.includes(ACTIVE) ? ACTIVE : TARGET}`)
      return '9999'
    }
    if (isReadinessRead(text) && text.includes('.hivewardd-readiness')) {
      if (overrides.readinessAtMs !== undefined && Date.now() < overrides.readinessAtMs) {
        return ''
      }
      if (text.includes(ACTIVE)) {
        return readyLine(ACTIVE)
      }
      return overrides.targetReady === false ? '' : readyLine(TARGET)
    }
    return ''
  })
}

function options(overrides: Partial<HivewarddRollbackOptions> = {}): HivewarddRollbackOptions {
  return {
    conn: Object.create(null),
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/u',
    record: record(),
    nodePath: '/usr/bin/node',
    userDataDir: '/home/u/.hiveward',
    bindHost: '127.0.0.1',
    port: 7777,
    census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 },
    recountCensus: async () => ({
      liveSessions: 0,
      startedSinceActivation: 0,
      daemonProtocolVersion: 3
    }),
    releaseIncumbentAdmission: async () => {},
    targetBuildHash: BUILD_HASH,
    targetDaemonProtocol: { protocolVersion: 3, previousProtocolVersions: [1, 2] },
    readinessTimeoutMs: 50,
    sleep: async () => {},
    now: () => new Date('2026-02-02T00:00:00.000Z'),
    ...overrides
  }
}

describe('rollbackHivewardd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stops, restores state, then starts the target — in that order', async () => {
    const log: string[] = []
    scriptHost(log)
    const result = await rollbackHivewardd(options())
    expect(result).toMatchObject({ outcome: 'rolled-back', target: TARGET })
    // Stop before replacing open state; restore before the older build can migrate it.
    expect(log).toEqual([`stop:${ACTIVE}`, 'rescue', 'restore', `launch:${TARGET}`])
  })

  it('allows rollback startup time after a slow bundled preflight', async () => {
    let elapsedMs = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsedMs)
    const log: string[] = []
    scriptHost(log, { readinessAtMs: 100_000 })
    try {
      const result = await rollbackHivewardd(
        options({
          readinessTimeoutMs: undefined,
          sleep: async () => {
            elapsedMs += 50_000
          }
        })
      )
      expect(result.outcome).toBe('rolled-back')
      expect(elapsedMs).toBe(100_000)
      expect(log).toEqual([`stop:${ACTIVE}`, 'rescue', 'restore', `launch:${TARGET}`])
    } finally {
      clock.mockRestore()
    }
  })

  it('refuses before touching anything when terminals started after activation', async () => {
    const log: string[] = []
    scriptHost(log)
    const result = await rollbackHivewardd(
      options({ census: { liveSessions: 3, startedSinceActivation: 2, daemonProtocolVersion: 3 } })
    )
    expect(result).toMatchObject({
      outcome: 'refused',
      code: 'hivewardd_rollback_orphans_live_terminals'
    })
    expect(log).toEqual([])
    expect(vi.mocked(writeAtomicHivewarddRemoteRecord)).not.toHaveBeenCalled()
  })

  it('counts again under the lock, closing admission, and stops nothing if a terminal opened', async () => {
    const log: string[] = []
    scriptHost(log)
    const releaseIncumbentAdmission = vi.fn(async () => {})
    const recountCensus = vi.fn(async () => ({
      liveSessions: 1,
      startedSinceActivation: 1,
      daemonProtocolVersion: 3
    }))
    const result = await rollbackHivewardd(options({ recountCensus, releaseIncumbentAdmission }))
    expect(result).toMatchObject({ outcome: 'refused', code: 'hivewardd_rollback_terminals_running' })
    expect(log).toEqual([])
    expect(vi.mocked(writeAtomicHivewarddRemoteRecord)).not.toHaveBeenCalled()
    // A serving incumbent must reopen admission immediately.
    expect(releaseIncumbentAdmission).toHaveBeenCalledOnce()
  })

  it('stops nothing, reopening admission, once its recount may have outlived the fence', async () => {
    const log: string[] = []
    scriptHost(log)
    let clockMs = Date.parse('2026-02-02T00:00:00.000Z')
    vi.mocked(writeAtomicHivewarddRemoteRecord).mockImplementationOnce(async () => {
      clockMs += HIVEWARDD_UPDATE_ADMISSION_STOP_BY_MS + 1
    })
    const releaseIncumbentAdmission = vi.fn(async () => {})
    const result = await rollbackHivewardd(
      options({ releaseIncumbentAdmission, now: () => new Date(clockMs) })
    )
    expect(result).toMatchObject({ outcome: 'refused', code: 'hivewardd_rollback_census_unavailable' })
    expect(log).toEqual([])
    expect(releaseIncumbentAdmission).toHaveBeenCalledOnce()
  })

  it('reopens admission when its stop was withdrawn before hivewardd acted on it', async () => {
    scriptHost([])
    barrier.state = 'withdrawn'
    const releaseIncumbentAdmission = vi.fn(async () => {})
    await expect(rollbackHivewardd(options({ releaseIncumbentAdmission }))).resolves.toMatchObject({
      code: 'hivewardd_rollback_stop_withdrawn'
    })
    expect(releaseIncumbentAdmission).toHaveBeenCalledOnce()
  })

  it('keeps admission closed once the rollback stops the server', async () => {
    const log: string[] = []
    scriptHost(log)
    const releaseIncumbentAdmission = vi.fn(async () => {})
    await expect(rollbackHivewardd(options({ releaseIncumbentAdmission }))).resolves.toMatchObject({
      outcome: 'rolled-back'
    })
    expect(releaseIncumbentAdmission).not.toHaveBeenCalled()
  })

  it('refuses when the snapshot is gone from the host', async () => {
    const log: string[] = []
    scriptHost(log, { snapshot: 'ABSENT' })
    const result = await rollbackHivewardd(options())
    expect(result).toMatchObject({ outcome: 'refused', code: 'hivewardd_rollback_snapshot_missing' })
    expect(log).toEqual([])
  })

  it('does not read a lost snapshot probe as a missing snapshot', async () => {
    const log: string[] = []
    scriptHost(log, { snapshot: '' })
    const result = await rollbackHivewardd(options())
    expect(result).toMatchObject({
      outcome: 'refused',
      code: 'hivewardd_rollback_snapshot_unverifiable'
    })
    expect(log).toEqual([])
  })

  it('puts the rescued state and the newer build back when the restore failed', async () => {
    const log: string[] = []
    scriptHost(log, { restores: ['FAILED'] })
    const result = await rollbackHivewardd(options())
    expect(result).toMatchObject({ outcome: 'failed', code: 'hivewardd_rollback_restore_failed' })
    expect(log).toEqual([
      `stop:${ACTIVE}`,
      'rescue',
      'restore',
      'restore-rescue',
      `launch:${ACTIVE}`
    ])
    expect(result.outcome === 'failed' && result.reason).toContain('is serving again')
  })

  it('keeps the newer state when a failed target may have changed it, until an operator accepts', async () => {
    const log: string[] = []
    scriptHost(log, { targetReady: false })
    const result = await rollbackHivewardd(options())
    expect(result).toMatchObject({ outcome: 'failed', code: 'hivewardd_activation_no_readiness' })
    expect(result.outcome === 'failed' && result.reason).toContain('Recover to restore')
    expect(result.outcome === 'failed' && result.reason).toContain(
      'Last lines of hivewardd.log:\nhivewardd: listen EADDRINUSE'
    )
    expect(log).toEqual([
      `stop:${ACTIVE}`,
      'rescue',
      'restore',
      `launch:${TARGET}`,
      `stop:${TARGET}`,
      'compare'
    ])
    // Keep active pointing at the recoverable incumbent until the target proves it is serving.
    expect(
      vi
        .mocked(writeAtomicHivewarddRemoteRecord)
        .mock.calls.some((call) => String(call[1]).endsWith('hivewardd-active.json'))
    ).toBe(false)
  })

  it('puts the newer build back unasked when a failed target left the restored state untouched', async () => {
    const log: string[] = []
    scriptHost(log, { targetReady: false, comparison: 'UNCHANGED' })
    const result = await rollbackHivewardd(options())
    expect(result.outcome === 'failed' && result.reason).toContain('is serving again')
    expect(log.slice(-3)).toEqual(['compare', 'restore-rescue', `launch:${ACTIVE}`])
    const compare = mockExec.mock.calls
      .map((call) => String(call[1]))
      .find((command) => command.includes('verdict=UNCHANGED'))
    expect(compare).not.toContain('rollback-rescue-')
  })

  it('keeps the newer state and restarts the newer build when work appeared after the census', async () => {
    const log: string[] = []
    scriptHost(log)
    barrier.state = 'unproven'
    const result = await rollbackHivewardd(options())
    expect(result).toMatchObject({ outcome: 'refused', code: 'hivewardd_rollback_terminals_at_stop' })
    expect(log).toEqual([`stop:${ACTIVE}`, `launch:${ACTIVE}`])
  })

  it('records the rollback only after the target answers healthy', async () => {
    const log: string[] = []
    scriptHost(log)
    await rollbackHivewardd(options())
    const written = vi
      .mocked(writeAtomicHivewarddRemoteRecord)
      .mock.calls.find((call) => String(call[1]).endsWith('hivewardd-active.json'))
    expect(JSON.parse(String(written?.[2]))).toMatchObject({
      active: TARGET,
      previous: null,
      snapshot: null
    })
  })
})
