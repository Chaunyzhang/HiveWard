import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyHivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'

const mocks = vi.hoisted(() => {
  const record: { active: string | null } = { active: '1.0.0+a' }
  return { stop: vi.fn(), write: vi.fn(), release: vi.fn(), record }
})
vi.mock('../../shared/runtime-environment-store', () => ({ listEnvironments: () => [] }))
vi.mock('../../shared/runtime-environment-managed-hivewardd-store', () => ({
  removeManagedHivewarddEnvironment: vi.fn()
}))
vi.mock('./hivewardd-migration-cutover-journal', () => ({
  findHivewarddMigrationSourceCutoverForTarget: () => ({
    phase: 'source-fenced',
    destinationEnvironmentId: 'env-1'
  })
}))
vi.mock('./hivewardd-migration-source-fence', () => ({
  releaseUndeployedMigrationFence: mocks.release
}))
vi.mock('../managed-server/lifecycle/hivewardd-managed-tunnel', () => ({
  closeHivewarddManagedTunnel: async () => undefined
}))
vi.mock('./targets/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({ getTarget: () => ({ id: 'ssh-1' }) }),
  getSshConnectionManager: () => ({ connect: async () => ({}) })
}))
vi.mock('../managed-server/install/hivewardd-remote-context', () => ({
  resolveHivewarddRemoteContext: async () => ({
    activationRecord: { ...emptyHivewarddActivationRecord(), active: mocks.record.active },
    connection: {},
    host: { os: 'linux' },
    remoteHome: '/home/u',
    userDataDir: '/home/u/.hiveward'
  })
}))
vi.mock('../managed-server/activation/hivewardd-activation-lock', () => ({
  withHivewarddActivationLock: async (_options: unknown, run: () => Promise<unknown>) => run()
}))
vi.mock('../managed-server/activation/hivewardd-activation-record-store', () => ({
  readHivewarddActivationRecord: async () => ({
    ...emptyHivewarddActivationRecord(),
    active: mocks.record.active
  }),
  writeHivewarddActivationRecord: mocks.write
}))
vi.mock('./hivewardd-recovery-slot', () => ({
  hivewarddSlotDir: (_slot: unknown, version: string) => `/slots/${version}`,
  stopHivewarddSlot: mocks.stop
}))

const { releaseUnreachableHivewarddSetup } = await import('./hivewardd-unreachable-setup-release')
const release = () =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: claims pass through to the mocked fence release only.
  releaseUnreachableHivewarddSetup({ userDataPath: '/u', claims: {} as never, targetId: 'ssh-1' })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.record.active = '1.0.0+a'
})

describe('releasing an unreachable setup', () => {
  it('stops the hivewardd it activated and clears active only on proven exit', async () => {
    mocks.stop.mockResolvedValueOnce('stopped')
    await release()
    expect(mocks.stop).toHaveBeenCalledWith(expect.anything(), '/slots/1.0.0+a', false)
    expect(mocks.write.mock.calls[0]?.[1]).toMatchObject({ active: null, previous: '1.0.0+a' })
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('keeps the record when the stop is not proven, and still releases the fence', async () => {
    mocks.stop.mockResolvedValueOnce('unconfirmed')
    await release()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('touches nothing on a host whose setup never activated', async () => {
    mocks.record.active = null
    await release()
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
