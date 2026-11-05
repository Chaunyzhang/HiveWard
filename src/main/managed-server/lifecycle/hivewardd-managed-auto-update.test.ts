import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emptyHivewarddActivationRecord,
  type HivewarddActivationRecord
} from '../activation/hivewardd-activation-record'
import { HivewarddHostUnsupportedError } from '../../hivewardd/hivewardd-host-unavailable'

const mocks = vi.hoisted(() => {
  const state: { record: HivewarddActivationRecord | null } = { record: null }
  return {
    state,
    materialize: vi.fn(async (_target: string) => '/cache/hivewardd'),
    runUpdate: vi.fn(),
    migrating: vi.fn((_userData: string, _environmentId: string): unknown => null)
  }
})

vi.mock('../../ssh/hivewardd-runtime-maintenance', () => ({
  withManagedHivewarddLifecycle: (
    _userData: string,
    _selector: string,
    run: (managed: unknown) => Promise<unknown>
  ) => run({ environment: { id: 'env-1' }, deployment: {} }),
  runManagedHivewarddUpdate: mocks.runUpdate
}))
vi.mock('./hivewardd-managed-runtime-context', () => ({
  resolveLinkedHivewarddContext: async () => ({
    activationRecord: mocks.state.record,
    serverTarget: 'linux-x64'
  })
}))
vi.mock('./hivewardd-managed-migration-status', () => ({
  findIncompleteManagedHivewarddMigration: mocks.migrating
}))
vi.mock('../../hivewardd/hivewardd-artifact-materializer', () => ({
  materializeHivewarddArtifact: mocks.materialize
}))
vi.mock('../install/remote-versioned-install', () => ({
  readLocalFullVersion: () => '0.1.0+new'
}))

import {
  autoUpdateManagedHivewarddEnvironment,
  resetBundledHivewarddVersionsForTests
} from './hivewardd-managed-auto-update'
import { planManagedHivewarddAutoUpdate } from './hivewardd-managed-update-decision'

function record(overrides: Partial<HivewarddActivationRecord>): HivewarddActivationRecord {
  return {
    ...emptyHivewarddActivationRecord(),
    active: '0.1.0+old',
    activeProduct: 'HiveWard',
    activeVersionFamily: 'hiveward',
    ...overrides
  }
}

const plan = (r: HivewarddActivationRecord, extra: { failedBefore?: boolean } = {}) =>
  planManagedHivewarddAutoUpdate({
    record: r,
    candidateVersion: '0.1.0+new',
    appVersion: '1.5.0',
    failedBefore: extra.failedBefore ?? false
  })

describe('whether a connect updates its managed hivewardd', () => {
  it('skips a host already on this build', () => {
    expect(plan(record({ active: '0.1.0+new' }))).toEqual({ action: 'skip', reason: 'current' })
  })

  it('updates a host an older or pre-tracking HiveWard activated', () => {
    expect(plan(record({ activeAppVersion: '1.4.0' }))).toEqual({ action: 'update' })
    expect(plan(record({}))).toEqual({ action: 'update' })
  })

  it('never downgrades a host a newer HiveWard activated', () => {
    expect(plan(record({ activeAppVersion: '1.6.0' }))).toEqual({
      action: 'skip',
      reason: 'host-newer'
    })
  })

  it('leaves alone a build an explicit rollback moved away from', () => {
    expect(plan(record({ rolledBackFrom: '0.1.0+new' }))).toEqual({
      action: 'skip',
      reason: 'rolled-back'
    })
  })

  it('does not retry an update that already failed for this app version', () => {
    expect(plan(record({}), { failedBefore: true })).toEqual({
      action: 'skip',
      reason: 'failed-before'
    })
  })

  it('skips when the template carries no build for the host', () => {
    expect(
      planManagedHivewarddAutoUpdate({
        record: record({}),
        candidateVersion: null,
        appVersion: '1.5.0',
        failedBefore: false
      })
    ).toEqual({ action: 'skip', reason: 'no-template' })
  })
})

describe('updating a managed hivewardd on connect', () => {
  const run = () =>
    autoUpdateManagedHivewarddEnvironment('/user-data', {
      environmentId: 'env-1',
      appVersion: '1.5.0',
      failedBefore: () => false,
      onUpdating: vi.fn()
    })

  beforeEach(() => {
    resetBundledHivewarddVersionsForTests()
    mocks.materialize.mockReset().mockResolvedValue('/cache/hivewardd')
    mocks.runUpdate.mockReset()
    mocks.migrating.mockReset().mockReturnValue(null)
    mocks.state.record = record({ activeAppVersion: '1.4.0' })
  })

  it('runs the Managed servers update, never forced past running terminals', async () => {
    mocks.runUpdate.mockResolvedValue({ outcome: 'updated', activeVersion: '0.1.0+new' })
    await expect(run()).resolves.toEqual({ outcome: 'updated', activeVersion: '0.1.0+new' })
    expect(mocks.runUpdate).toHaveBeenCalledWith(
      '/user-data',
      expect.anything(),
      expect.anything(),
      { admitRecord: expect.any(Function) }
    )
  })

  it.each([
    ['active', record({ active: '0.1.1+newer', activeAppVersion: '1.6.0' })],
    ['stopped', record({ active: null, previous: '0.1.1+newer', activeAppVersion: '1.6.0' })]
  ])(
    'skips when the record under the fence names a newer %s build than the one planned on',
    async (_name, lockedRecord) => {
      let admitted: string | null = 'not called'
      mocks.runUpdate.mockImplementation(async (_u, _m, _c, args) => {
        admitted = args.admitRecord(lockedRecord)
        return { outcome: 'deferred', code: 'hivewardd_activation_policy_refused', reason: 'x' }
      })
      await expect(run()).resolves.toEqual({ outcome: 'skipped', reason: 'host-newer' })
      expect(admitted).toEqual(expect.any(String))
    }
  )

  it('admits the record under the fence when it still allows this build', async () => {
    let admitted: string | null = 'not called'
    mocks.runUpdate.mockImplementation(async (_u, _m, _c, args) => {
      admitted = args.admitRecord(record({ activeAppVersion: '1.4.0' }))
      return { outcome: 'updated', activeVersion: '0.1.0+new' }
    })
    await expect(run()).resolves.toMatchObject({ outcome: 'updated' })
    expect(admitted).toBeNull()
  })

  it('reports live terminals as a wait, and a rejected candidate as a failure', async () => {
    mocks.runUpdate.mockResolvedValueOnce({
      outcome: 'deferred',
      code: 'hivewardd_update_terminals_running',
      reason: '1 terminal is running on this host.'
    })
    await expect(run()).resolves.toMatchObject({ outcome: 'deferred' })

    mocks.runUpdate.mockResolvedValueOnce({
      outcome: 'deferred',
      code: 'hivewardd_activation_fence_busy',
      reason: 'Another run is changing this host.'
    })
    await expect(run()).resolves.toMatchObject({ outcome: 'deferred' })

    mocks.runUpdate.mockResolvedValueOnce({
      outcome: 'deferred',
      code: 'hivewardd_candidate_launch_failed',
      reason: 'The candidate failed while starting. hivewardd 0.1.0+old was restarted.'
    })
    await expect(run()).resolves.toEqual({
      outcome: 'failed',
      reason: 'The candidate failed while starting. hivewardd 0.1.0+old was restarted.'
    })

    mocks.runUpdate.mockRejectedValueOnce(new Error('Could not snapshot state'))
    await expect(run()).resolves.toEqual({ outcome: 'failed', reason: 'Could not snapshot state' })
  })

  it('reads the bundled build once per session', async () => {
    mocks.state.record = record({ active: '0.1.0+new' })
    await run()
    await run()
    expect(mocks.materialize).toHaveBeenCalledTimes(1)
    expect(mocks.runUpdate).not.toHaveBeenCalled()
  })

  it('leaves a server alone while a migration into it is still running', async () => {
    mocks.migrating.mockReturnValue({ migrationId: 'm', phase: 'staged' })
    await expect(run()).resolves.toEqual({ outcome: 'skipped', reason: 'migrating' })
    expect(mocks.runUpdate).not.toHaveBeenCalled()
  })

  it('skips a host whose target the template does not carry', async () => {
    mocks.materialize.mockRejectedValue(new HivewarddHostUnsupportedError('no linux-x64'))
    await expect(run()).resolves.toEqual({ outcome: 'skipped', reason: 'no-template' })
  })
})
