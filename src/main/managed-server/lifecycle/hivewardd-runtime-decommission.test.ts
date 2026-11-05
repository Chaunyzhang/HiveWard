import { existsSync, readFileSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedHivewarddFenceEnvironmentId } from '../../../shared/managed-hivewardd-ssh-owner'
import { getRuntimeEnvironmentSidecarPath } from '../../../shared/runtime-environment-sidecar'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import {
  listHivewarddMigrationSourceCutovers,
  writeHivewarddMigrationSourceCutover
} from '../../ssh/hivewardd-migration-cutover-journal'
import { hivewarddMigrationCutoverFixture } from '../../ssh/hivewardd-migration-cutover-fixture'
import {
  createManagedLifecycleHarness,
  MANAGED_VERSION
} from './hivewardd-managed-lifecycle-test-fixture'

const mocks = vi.hoisted(() => {
  const state: { store: unknown; transaction: unknown } = { store: null, transaction: null }
  return {
    state,
    resolveContext: vi.fn(),
    census: vi.fn(),
    decommission: vi.fn(),
    recover: vi.fn(),
    cancel: vi.fn(),
    keepServing: vi.fn(),
    closeTunnel: vi.fn(),
    ensureTunnel: vi.fn(),
    retire: vi.fn()
  }
})

vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: async () => ({}) }),
  getSshTargetRegistryStore: () => mocks.state.store
}))
vi.mock('../install/hivewardd-remote-context', () => ({
  resolveHivewarddRemoteContext: mocks.resolveContext
}))
vi.mock('../../ssh/hivewardd-terminal-census-client', () => ({
  collectManagedTerminalCensus: mocks.census
}))
vi.mock('../install/hivewardd-remote-decommission', () => ({
  decommissionRemoteHivewardd: mocks.decommission
}))
vi.mock('../activation/hivewardd-activation-recovery', () => ({
  recoverInterruptedHivewarddActivation: mocks.recover
}))
vi.mock('../activation/hivewardd-activation-transaction-store', () => ({
  readHivewarddActivationTransaction: async () => mocks.state.transaction
}))
vi.mock('../activation/hivewardd-activation-lock', () => ({
  withStaleHivewarddActivationRecoveryLock: async (
    _options: unknown,
    run: (lock: { retain: () => void }) => Promise<unknown>
  ) => run({ retain: () => {} })
}))
vi.mock('./hivewardd-managed-remote-stop', () => ({ cancelRemoteHivewarddManagedStop: mocks.cancel }))
vi.mock('./hivewardd-decommission-recovery', () => ({ reconcileHivewarddDecommission: mocks.keepServing }))
vi.mock('./hivewardd-managed-tunnel', () => ({
  closeHivewarddManagedTunnel: mocks.closeTunnel,
  ensureHivewarddManagedTunnel: mocks.ensureTunnel
}))

const { cancelManagedHivewarddStop, stopManagedHivewarddEnvironment } =
  await import('./hivewardd-runtime-decommission')

const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 7 }
let harness: ReturnType<typeof createManagedLifecycleHarness>

const stop = (isActive = false) =>
  stopManagedHivewarddEnvironment(
    harness.userDataPath,
    { selector: 'Managed' },
    { isActiveEnvironment: () => isActive, retireLocalState: mocks.retire }
  )

function expectStillLinked(): void {
  expect(listEnvironments(harness.userDataPath)[0]?.hivewarddDeployment).toBeDefined()
  expect(getManagedHivewarddFenceEnvironmentId(harness.current())).toBe('environment-1')
  expect(mocks.retire).not.toHaveBeenCalled()
  expect(mocks.closeTunnel).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  harness = createManagedLifecycleHarness()
  mocks.state.store = harness.targetStore
  mocks.state.transaction = null
  mocks.resolveContext.mockImplementation(async () => harness.context())
  mocks.census.mockResolvedValue(idle)
})

afterEach(() => rmSync(harness.userDataPath, { recursive: true, force: true }))

describe('stopManagedHivewarddEnvironment', () => {
  it('unlinks the server only after the host proves hivewardd exited', async () => {
    writeHivewarddMigrationSourceCutover(harness.userDataPath, {
      ...hivewarddMigrationCutoverFixture('migration-1', 'ssh-1', { environmentId: 'environment-1' }),
      phase: 'destination-committed',
      sourceRetainedAt: '2026-10-01T00:00:00.000Z'
    })
    mocks.decommission.mockResolvedValueOnce({
      outcome: 'decommissioned',
      version: MANAGED_VERSION,
      retirement: 'retired'
    })
    await expect(stop()).resolves.toEqual({
      outcome: 'unlinked',
      verdict: 'exited',
      environmentId: 'environment-1',
      sshTargetId: 'ssh-1',
      stoppedVersion: MANAGED_VERSION,
      retirement: 'retired'
    })
    expect(mocks.decommission.mock.calls[0]?.[0]).toMatchObject({ census: idle, port: 6_768 })
    expect(listEnvironments(harness.userDataPath)).toEqual([])
    expect(
      readFileSync(getRuntimeEnvironmentSidecarPath(harness.userDataPath), 'utf8')
    ).not.toContain('hivewarddDeployment')
    expect(harness.current().hivewarddFence).toBeUndefined()
    // Persisted with the release so a reload or relaunch cannot deploy a replacement.
    expect(harness.current().managedServerRemoved).toBeDefined()
    expect(harness.flushes).toHaveLength(1)
    expect(mocks.retire).toHaveBeenCalledWith('environment-1')
    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
    // Retained journals would block later conversions of this host.
    expect(listHivewarddMigrationSourceCutovers(harness.userDataPath)).toEqual([])
  })

  it.each([
    ['live', 'hivewardd_decommission_terminals_running'],
    ['unverifiable', 'hivewardd_decommission_census_unavailable'],
    ['unverifiable', 'hivewardd_decommission_stop_unsettled']
  ] as const)('keeps every link when the verdict is %s (%s)', async (verdict, code) => {
    mocks.decommission.mockResolvedValueOnce({ outcome: 'refused', verdict, code, reason: 'no' })
    await expect(stop()).resolves.toMatchObject({ outcome: 'refused', verdict, code })
    expectStillLinked()
    expect(existsSync(getRuntimeEnvironmentSidecarPath(harness.userDataPath))).toBe(true)
  })

  it('refuses the Active Server before contacting the host', async () => {
    await expect(stop(true)).resolves.toMatchObject({ code: 'hivewardd_stop_active_environment' })
    expect(mocks.resolveContext).not.toHaveBeenCalled()
    expectStillLinked()
  })

  it('finishes an interrupted stop from its journal and unlinks only on proven exit', async () => {
    mocks.state.transaction = { operation: 'decommission', activeVersion: MANAGED_VERSION }
    mocks.recover.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'hivewardd_recovery_decommission_unsettled',
      reason: 'no answer'
    })
    await expect(stop()).resolves.toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expectStillLinked()
    mocks.recover.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: null,
      readiness: null
    })
    await expect(stop()).resolves.toMatchObject({ outcome: 'unlinked', verdict: 'exited' })
    expect(mocks.decommission).not.toHaveBeenCalled()
  })

  it('starts over, never reading live, when another run settled the journal first', async () => {
    mocks.state.transaction = { operation: 'decommission', activeVersion: MANAGED_VERSION }
    mocks.recover.mockImplementationOnce(async () => {
      mocks.state.transaction = null
      return { outcome: 'none' }
    })
    mocks.decommission.mockResolvedValueOnce({
      outcome: 'decommissioned',
      version: MANAGED_VERSION,
      retirement: null
    })
    await expect(stop()).resolves.toMatchObject({ outcome: 'unlinked', verdict: 'exited' })

    rmSync(harness.userDataPath, { recursive: true, force: true })
    harness = createManagedLifecycleHarness()
    mocks.state.store = harness.targetStore
    mocks.state.transaction = { operation: 'decommission', activeVersion: MANAGED_VERSION }
    mocks.recover.mockResolvedValue({ outcome: 'none' })
    await expect(stop()).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'hivewardd_stop_journal_changed'
    })
  })

  it('refuses while another interrupted operation holds the journal', async () => {
    mocks.state.transaction = { operation: 'activate' }
    await expect(stop()).resolves.toMatchObject({ code: 'hivewardd_activation_recovery_required' })
    expectStillLinked()
  })

  it('unlinks a server whose record already shows nothing active', async () => {
    mocks.resolveContext.mockImplementation(async () => harness.context({ active: null }))
    await expect(stop()).resolves.toMatchObject({ outcome: 'unlinked', stoppedVersion: null })
    expect(mocks.decommission).not.toHaveBeenCalled()
  })
})

describe('cancelManagedHivewarddStop', () => {
  const request = { transactionId: 't-1', version: MANAGED_VERSION }
  const cancel = () => cancelManagedHivewarddStop(harness.userDataPath, { selector: 'Managed' })

  it('has nothing to cancel without a decommission journal', async () => {
    await expect(cancel()).resolves.toEqual({ outcome: 'none' })
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('withdraws a stop hivewardd never acted on and keeps the server serving', async () => {
    mocks.state.transaction = {
      operation: 'decommission',
      phase: 'stop-dispatched',
      activeVersion: MANAGED_VERSION,
      request
    }
    mocks.cancel.mockResolvedValueOnce({ outcome: 'canceled' })
    mocks.keepServing.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: MANAGED_VERSION,
      readiness: null
    })
    await expect(cancel()).resolves.toEqual({ outcome: 'canceled', activeVersion: MANAGED_VERSION })
    expect(mocks.keepServing.mock.calls[0]?.[1]).toEqual({
      action: 'keep-serving',
      version: MANAGED_VERSION
    })
    expect(mocks.ensureTunnel).toHaveBeenCalledOnce()
    expectStillLinked()
  })

  it('refuses once hivewardd already acted on the stop', async () => {
    mocks.state.transaction = {
      operation: 'decommission',
      phase: 'stop-dispatched',
      activeVersion: MANAGED_VERSION,
      request
    }
    mocks.cancel.mockResolvedValueOnce({ outcome: 'dispatched' })
    await expect(cancel()).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'live',
      code: 'hivewardd_stop_already_dispatched'
    })
    expect(mocks.keepServing).not.toHaveBeenCalled()
  })

  it('reports an already-exited stop for stop to finish', async () => {
    mocks.state.transaction = {
      operation: 'decommission',
      phase: 'process-exited',
      activeVersion: MANAGED_VERSION,
      request
    }
    await expect(cancel()).resolves.toEqual({ outcome: 'already-stopped' })
    expectStillLinked()
  })
})
