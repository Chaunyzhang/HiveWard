import { describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import type * as InstallLock from '../install/remote-install-lock'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn().mockResolvedValue('')
}))
vi.mock('../install/remote-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn().mockResolvedValue(undefined)
}))

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { acquireInstallLock, RemoteInstallLockBusyError } from '../install/remote-install-lock'
import {
  parseHivewarddActivationTransaction,
  planHivewarddTransactionRecovery,
  serializeHivewarddActivationTransaction,
  type HivewarddActivationTransaction
} from './hivewardd-activation-transaction'
import {
  createHivewarddActivationTransaction,
  createHivewarddRollbackTransaction,
  withHivewarddActivationCandidateReady,
  withHivewarddActivationIncumbentStopped,
  withHivewarddActivationSnapshot,
  withHivewarddRollbackPhase,
  withHivewarddRollbackRescue
} from './hivewardd-activation-transaction-transitions'
import {
  resolveHivewarddActivationReadinessTimeout,
  withHivewarddActivationLock,
  withStaleHivewarddActivationRecoveryLock
} from './hivewardd-activation-lock'
import { FakeHivewarddHost, NEW, OLD } from './hivewardd-activation-host-test-harness'
import { withRolledBackVersion } from './hivewardd-activation-record'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

const T = new Date('2026-02-02T00:00:00.000Z')
const ID = '7f1c2a7e-6c1b-4a8e-9f0e-0a1b2c3d4e5f'
const before = FakeHivewarddHost.newRecord()

function activation(): ReturnType<typeof createHivewarddActivationTransaction> {
  return createHivewarddActivationTransaction({
    transactionId: ID,
    candidateVersion: '0.3.0+cc01',
    recordBefore: before,
    snapshotDirName: 'pre-0.3.0+cc01-1',
    now: T
  })
}

function rollback(): ReturnType<typeof createHivewarddRollbackTransaction> {
  return createHivewarddRollbackTransaction({
    transactionId: ID,
    incumbentVersion: NEW,
    targetVersion: OLD,
    recordBefore: before,
    recordAfter: withRolledBackVersion(before, T),
    rescueDirName: 'rollback-rescue-0.2.0+bb01-1',
    now: T
  })
}

const roundTrip = (transaction: HivewarddActivationTransaction): unknown =>
  parseHivewarddActivationTransaction(serializeHivewarddActivationTransaction(transaction))

describe('parseHivewarddActivationTransaction', () => {
  it('round-trips every phase of both operations', () => {
    const stopped = withHivewarddActivationIncumbentStopped(activation(), T)
    const captured = withHivewarddActivationSnapshot(stopped, 'captured', T)
    const ready = withHivewarddActivationCandidateReady(
      captured,
      { ...before, active: '0.3.0+cc01' },
      T
    )
    const rescued = withHivewarddRollbackRescue(
      withHivewarddRollbackPhase(rollback(), 'incumbent-stopped', T),
      'empty',
      T
    )
    for (const transaction of [activation(), stopped, captured, ready, rollback(), rescued]) {
      expect(roundTrip(transaction)).toEqual({ state: 'ok', transaction })
    }
  })

  it.each([
    ['an unknown operation, so an older client keeps a newer fence', { operation: 'decommission' }],
    ['a snapshot verdict before its phase', { snapshot: { dirName: 'pre-x', state: 'captured' } }],
    ['a committed record before candidate-ready', { recordAfter: before }],
    ['an unsafe version', { candidateVersion: '../../etc' }],
    ['an unsafe snapshot name', { snapshot: { dirName: '../x', state: 'pending' } }]
  ])('reads %s as unreadable', (_name, patch) => {
    const raw = JSON.stringify({ ...activation(), ...patch })
    expect(parseHivewarddActivationTransaction(raw)).toMatchObject({ state: 'unreadable' })
  })

  it('rejects a rollback whose versions disagree with its records', () => {
    const raw = JSON.stringify({ ...rollback(), targetVersion: '0.0.9+dd01' })
    expect(parseHivewarddActivationTransaction(raw)).toMatchObject({ state: 'unreadable' })
  })
})

describe('planHivewarddTransactionRecovery', () => {
  const after = { ...before, active: '0.3.0+cc01' }
  const captured = withHivewarddActivationSnapshot(
    withHivewarddActivationIncumbentStopped(activation(), T),
    'captured',
    T
  )

  it.each([
    ['prepared', activation(), null, null],
    ['incumbent-stopped', withHivewarddActivationIncumbentStopped(activation(), T), null, null],
    ['snapshot-captured', captured, '0.3.0+cc01', 'captured']
  ] as const)('undoes an activation interrupted at %s', (_phase, transaction, launched, state) => {
    expect(planHivewarddTransactionRecovery(transaction, before)).toMatchObject({
      action: 'undo',
      launchedVersion: launched,
      activeVersion: NEW,
      restoreState: state === null ? null : { state }
    })
  })

  it('finishes a commit whose record write was lost, and stabilizes one that landed', () => {
    const ready = withHivewarddActivationCandidateReady(captured, after, T)
    expect(planHivewarddTransactionRecovery(ready, before)).toEqual({
      action: 'finish-commit',
      record: after
    })
    expect(planHivewarddTransactionRecovery(ready, after)).toEqual({
      action: 'stabilize-committed',
      activeVersion: '0.3.0+cc01'
    })
  })

  it('restores the rescue once a rollback may have replaced the state', () => {
    const rescued = withHivewarddRollbackRescue(rollback(), 'captured', T)
    expect(planHivewarddTransactionRecovery(rescued, before)).toMatchObject({
      action: 'undo',
      launchedVersion: null,
      activeVersion: NEW,
      restoreState: { state: 'captured' }
    })
    expect(
      planHivewarddTransactionRecovery(
        withHivewarddRollbackPhase(rescued, 'rollback-state-restored', T),
        before
      )
    ).toMatchObject({
      launchedVersion: OLD,
      launchedFromState: { state: 'captured', dirName: before.snapshot?.dirName }
    })
  })

  it('refuses when the record matches neither side', () => {
    expect(planHivewarddTransactionRecovery(activation(), { ...before, previous: null })).toMatchObject(
      {
        action: 'refuse',
        code: 'hivewardd_recovery_activation_record_changed'
      }
    )
  })
})

describe('activation fence', () => {
  const target = {
    conn: Object.create(null),
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/u'
  }
  const removals = (): string[] =>
    vi
      .mocked(execCommand)
      .mock.calls.map(([, command]) => command)
      .filter((command) => command.includes('rm -'))

  const orphanings = (): string[] =>
    vi
      .mocked(execCommand)
      .mock.calls.map(([, command]) => command)
      .filter((command) => command.includes('touch -m -t 200001010000'))

  const locked = <T>(run: Parameters<typeof withHivewarddActivationLock<T>>[1]): Promise<T> =>
    withHivewarddActivationLock(target, run, () => {
      throw new Error('fence held')
    })

  it('answers a fence still held after a short wait, running nothing', async () => {
    vi.clearAllMocks()
    vi.mocked(acquireInstallLock).mockRejectedValueOnce(new RemoteInstallLockBusyError('/l', 0))
    const run = vi.fn(async () => 'ran')
    await expect(withHivewarddActivationLock(target, run, () => 'held')).resolves.toBe('held')
    expect(vi.mocked(acquireInstallLock).mock.calls[0]?.[3]).toMatchObject({ waitTimeoutMs: 5_000 })
    expect(run).not.toHaveBeenCalled()
    expect(removals()).toEqual([])
  })

  it('never takes over a held fence by age, and removes the journal before the lock', async () => {
    vi.clearAllMocks()
    await locked(async () => undefined)
    expect(vi.mocked(acquireInstallLock).mock.calls[0]?.[3]).toMatchObject({
      allowStaleTakeover: false,
      relayGcClaim: false
    })
    const [release] = removals()
    // Release must prove ownership and remove journal before lock.
    expect(release).toMatch(
      /^\[ "\$\(cat '[^']*\.hiveward-fence-owner' 2>\/dev\/null\)" = '[^']+' \] \|\| \{ echo SUPERSEDED; exit 0; \};/u
    )
    expect(release?.indexOf('transaction.json')).toBeLessThan(
      release?.indexOf("mv '/home/u/.hiveward-remote/.hivewardd-activation-transaction/.install-lock'") ??
        -1
    )
  })

  it('keeps the fence after an unconfirmed termination, a retained error, or retain()', async () => {
    vi.clearAllMocks()
    const lost = Object.assign(new Error('lost'), { sshChannelCloseConfirmed: false })
    await expect(locked(() => Promise.reject(lost))).rejects.toBe(lost)
    await expect(
      locked(async (lock) => {
        lock.retainOnError()
        throw new Error('mid-transaction')
      })
    ).rejects.toThrow('mid-transaction')
    await locked(async (lock) => lock.retain())
    expect(removals()).toEqual([])
    // Completed work may orphan its fence; unconfirmed commands must keep theirs fresh.
    expect(orphanings()).toHaveLength(2)
  })

  it('marks a fence recovery retained as ownerless, so the next recovery need not wait', async () => {
    vi.clearAllMocks()
    await withStaleHivewarddActivationRecoveryLock(target, async (lock) => lock.retain())
    await expect(
      withStaleHivewarddActivationRecoveryLock(target, () => Promise.reject(new Error('refused')))
    ).rejects.toThrow('refused')
    expect(orphanings()).toHaveLength(2)
    expect(removals()).toEqual([])
  })

  it('releases after a recovered failure even though the run throws', async () => {
    vi.clearAllMocks()
    await expect(
      locked(async (lock) => {
        lock.retainOnError()
        lock.recovered()
        throw new Error('snapshot failed; incumbent restarted')
      })
    ).rejects.toThrow('incumbent restarted')
    expect(removals()).toHaveLength(1)
  })

  it('lets recovery take over only stale fences, without waiting', async () => {
    vi.clearAllMocks()
    await withStaleHivewarddActivationRecoveryLock(target, async () => undefined)
    expect(vi.mocked(acquireInstallLock).mock.calls[0]?.[3]).toMatchObject({
      allowStaleTakeover: true,
      waitTimeoutMs: 0
    })
  })

  it.each([0, -1, 5 * 60_000 + 1, 1.5])('rejects readiness timeout %s', (timeout) => {
    expect(() => resolveHivewarddActivationReadinessTimeout(timeout, 1)).toThrow()
  })
})
