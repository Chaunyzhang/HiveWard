import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedHivewarddFenceEnvironmentId } from '../../../shared/managed-hivewardd-ssh-owner'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import {
  listHivewarddMigrationSourceCutovers,
  writeHivewarddMigrationSourceCutover
} from '../../ssh/hivewardd-migration-cutover-journal'
import { hivewarddMigrationCutoverFixture } from '../../ssh/hivewardd-migration-cutover-fixture'
import { createManagedLifecycleHarness } from './hivewardd-managed-lifecycle-test-fixture'
import { isManagedHivewarddSshTarget } from '../../ssh/connection/ssh-connection-store'

const mocks = vi.hoisted(() => {
  const state: { store: unknown } = { store: null }
  return {
    state,
    connect: vi.fn(),
    resolveContext: vi.fn(),
    closeTunnel: vi.fn(),
    retire: vi.fn()
  }
})

vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: mocks.connect }),
  getSshTargetRegistryStore: () => mocks.state.store
}))
vi.mock('../install/hivewardd-remote-context', () => ({
  resolveHivewarddRemoteContext: mocks.resolveContext
}))
vi.mock('./hivewardd-managed-tunnel', () => ({
  closeHivewarddManagedTunnel: mocks.closeTunnel,
  ensureHivewarddManagedTunnel: vi.fn()
}))

const { forgetManagedHivewarddEnvironment, stopManagedHivewarddEnvironment } =
  await import('./hivewardd-runtime-decommission')

let harness: ReturnType<typeof createManagedLifecycleHarness>

const policy = (isActive = false) => ({
  isActiveEnvironment: () => isActive,
  retireLocalState: mocks.retire
})

beforeEach(() => {
  vi.resetAllMocks()
  harness = createManagedLifecycleHarness()
  mocks.state.store = harness.targetStore
  mocks.connect.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:2841'))
  mocks.resolveContext.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:2841'))
})

afterEach(() => rmSync(harness.userDataPath, { recursive: true, force: true }))

describe('a managed server whose host is gone (P1-E)', () => {
  it('cannot be stopped, since the host can never prove hivewardd exited', async () => {
    await expect(
      stopManagedHivewarddEnvironment(harness.userDataPath, { selector: 'Managed' }, policy())
    ).rejects.toThrow('ECONNREFUSED')
    expect(listEnvironments(harness.userDataPath)).toHaveLength(1)
    expect(isManagedHivewarddSshTarget(harness.current())).toBe(true)
  })

  it('is forgotten locally without contacting the host, which frees its SSH target', async () => {
    writeHivewarddMigrationSourceCutover(harness.userDataPath, {
      ...hivewarddMigrationCutoverFixture('migration-1', 'ssh-1', { environmentId: 'environment-1' }),
      phase: 'destination-committed',
      sourceRetainedAt: '2026-10-01T00:00:00.000Z'
    })
    await expect(
      forgetManagedHivewarddEnvironment(harness.userDataPath, { selector: 'Managed' }, policy())
    ).resolves.toEqual({
      outcome: 'forgotten',
      // No host observation means local forgetting cannot report proven exit.
      verdict: 'unverifiable',
      environmentId: 'environment-1',
      sshTargetId: 'ssh-1'
    })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.resolveContext).not.toHaveBeenCalled()
    expect(listEnvironments(harness.userDataPath)).toEqual([])
    expect(getManagedHivewarddFenceEnvironmentId(harness.current())).toBeNull()
    expect(isManagedHivewarddSshTarget(harness.current())).toBe(false)
    expect(harness.flushes).toHaveLength(1)
    expect(mocks.retire).toHaveBeenCalledWith('environment-1')
    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
    expect(listHivewarddMigrationSourceCutovers(harness.userDataPath)).toEqual([])
  })

  it('refuses to forget the Active Server and keeps every link', async () => {
    await expect(
      forgetManagedHivewarddEnvironment(harness.userDataPath, { selector: 'Managed' }, policy(true))
    ).resolves.toMatchObject({ outcome: 'refused', code: 'hivewardd_forget_active_environment' })
    expect(listEnvironments(harness.userDataPath)).toHaveLength(1)
    expect(getManagedHivewarddFenceEnvironmentId(harness.current())).toBe('environment-1')
    expect(mocks.retire).not.toHaveBeenCalled()
    expect(mocks.closeTunnel).not.toHaveBeenCalled()
  })
})
