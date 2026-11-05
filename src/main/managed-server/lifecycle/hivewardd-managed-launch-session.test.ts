import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  HIVEWARDD_UPDATE_ADMISSION_FENCE_MS,
  HIVEWARDD_UPDATE_ADMISSION_STOP_BY_MS
} from '../../../shared/hivewardd-terminal-census'

const mocks = vi.hoisted(() => {
  const host: { current: RemoteHostPlatform | null } = { current: null }
  const active: { current: string | null } = { current: '1.0.0' }
  return {
    census: vi.fn(),
    stop: vi.fn(),
    wake: vi.fn(),
    rebuild: vi.fn(async () => {}),
    exec: vi.fn(),
    retain: vi.fn(),
    host,
    active,
    lockBusy: { current: false }
  }
})

vi.mock('../../ssh/hivewardd-runtime-maintenance', () => ({
  withManagedHivewarddLifecycle: (
    _path: string,
    _selector: string,
    run: (managed: unknown) => Promise<unknown>
  ) => run({ environment: { id: 'env-1' }, deployment: { remotePort: 7777 } })
}))
vi.mock('./hivewardd-managed-runtime-context', () => ({
  requireManagedHivewarddEnvironment: () => ({
    environment: { id: 'env-1' },
    deployment: { remotePort: 7777 }
  }),
  resolveLinkedHivewarddContext: async () => ({
    host: mocks.host.current,
    connection: {},
    remoteHome: '/Users/dev',
    activationRecord: { active: mocks.active.current }
  }),
  requireManagedHivewarddInfrastructure: () => ({
    connectionManager: {
      getState: () => ({ status: 'connected' }),
      getConnection: () => ({})
    },
    targetStore: { getTarget: () => ({ id: 'ssh-1' }) }
  }),
  managedHivewarddSlot: () => ({
    host: mocks.host.current,
    remoteHome: '/Users/dev',
    userDataDir: '/Users/dev/.hiveward'
  }),
  managedHivewarddInstallDir: () => '/Users/dev/.hiveward-remote/hivewardd-1.0.0'
}))
vi.mock('../install/hivewardd-remote-context', () => ({
  resolveHivewarddRemoteContext: async () => ({
    host: mocks.host.current,
    connection: {},
    remoteHome: '/Users/dev',
    userDataDir: '/Users/dev/.hiveward',
    activationRecord: { active: mocks.active.current }
  })
}))
vi.mock('../../ssh/hivewardd-ssh-host-transport', () => ({ sshHivewarddHostTransport: (c: unknown) => c }))
vi.mock('../activation/hivewardd-activation-lock', () => ({
  withHivewarddActivationLock: (
    _slot: unknown,
    run: (lock: unknown) => Promise<unknown>,
    busy: () => unknown
  ) => (mocks.lockBusy.current ? busy() : run({ retain: mocks.retain }))
}))
vi.mock('../activation/hivewardd-activation-record-store', () => ({
  readHivewarddActivationRecord: async () => ({ active: mocks.active.current })
}))
vi.mock('./hivewardd-managed-remote-stop', () => ({
  readRemoteHivewarddManagedStopTarget: async () => ({ state: 'ready', context: { version: '1.0.0' } })
}))
vi.mock('./hivewardd-rollback-terminal-barrier', () => ({
  stopIncumbentBehindTerminalBarrier: mocks.stop
}))
vi.mock('./hivewardd-managed-wake', () => ({ wakeStoppedManagedHivewardd: mocks.wake }))
vi.mock('./hivewardd-managed-tunnel', () => ({ rebuildHivewarddManagedTunnel: mocks.rebuild }))
vi.mock('../../ssh/hivewardd-terminal-census-client', () => ({
  collectManagedTerminalCensus: mocks.census
}))
vi.mock('../install/hivewardd-remote-runtime-control', () => ({
  execHivewarddRemote: mocks.exec
}))

const { readManagedHivewarddLaunchSshSession, restartManagedHivewarddEnvironment } =
  await import('./hivewardd-managed-launch-session')

const census = (liveSessions: number | null) => ({
  liveSessions,
  startedSinceActivation: liveSessions,
  daemonProtocolVersion: 1
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.host.current = getRemoteHostPlatform('darwin-arm64')
  mocks.active.current = '1.0.0'
  mocks.lockBusy.current = false
  mocks.stop.mockResolvedValue({ state: 'retired' })
  mocks.exec.mockResolvedValue('')
  mocks.wake.mockResolvedValue({ outcome: 'started', readiness: {} })
})

describe('restartManagedHivewarddEnvironment', () => {
  it.each([2, null])(
    'never stops a server while terminals run or are uncounted (%s)',
    async (n) => {
      mocks.census.mockResolvedValue(census(n))
      await expect(restartManagedHivewarddEnvironment('/u', 'env-1')).resolves.toEqual({
        outcome: 'terminals-running',
        liveSessions: n
      })
      expect(mocks.stop).not.toHaveBeenCalled()
      expect(mocks.wake).not.toHaveBeenCalled()
    }
  )

  it('stops, starts from this session and follows the new port', async () => {
    mocks.census.mockResolvedValue(census(0))
    await expect(restartManagedHivewarddEnvironment('/u', 'env-1')).resolves.toEqual({
      outcome: 'restarted',
      environmentId: 'env-1'
    })
    expect(mocks.stop).toHaveBeenCalledOnce()
    expect(mocks.wake).toHaveBeenCalledOnce()
    expect(mocks.rebuild).toHaveBeenCalledWith('/u', 'env-1')
  })

  it('does not claim recovery when the restart’s own SSH session already ended', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.exec.mockImplementation(async (_slot: unknown, command: string) =>
      command.includes('sw_vers') ? 'EXITED\n' : ''
    )
    const result = await restartManagedHivewarddEnvironment('/u', 'env-1')
    expect(result.outcome).toBe('not-restarted')
    expect(mocks.wake).toHaveBeenCalledOnce()
  })

  it('keeps the fence when the stop may still be running', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.stop.mockResolvedValue({ state: 'unsettled', reason: 'still stopping' })
    await restartManagedHivewarddEnvironment('/u', 'env-1')
    expect(mocks.retain).toHaveBeenCalledOnce()
  })

  it('leaves a server it could not prove stopped running', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.stop.mockResolvedValue({ state: 'unsettled', reason: 'still stopping' })
    const result = await restartManagedHivewarddEnvironment('/u', 'env-1')
    expect(result).toEqual({ outcome: 'not-restarted', reason: 'still stopping' })
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('starts the server again but keeps the warning when the daemon was not retired', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.stop.mockResolvedValue({ state: 'unproven', reason: 'a terminal started' })
    const result = await restartManagedHivewarddEnvironment('/u', 'env-1')
    expect(result.outcome).toBe('not-restarted')
    expect(mocks.wake).toHaveBeenCalledOnce()
    expect(mocks.rebuild).toHaveBeenCalledOnce()
  })
})

describe('restartManagedHivewarddEnvironment terminal admission', () => {
  const closes = () => mocks.census.mock.calls.map((call) => call[4]?.closeAdmissionForMs)
  const FENCED = [undefined, HIVEWARDD_UPDATE_ADMISSION_FENCE_MS]

  it('closes admission at its count under the host lock, so nothing starts before the stop', async () => {
    mocks.census.mockResolvedValue(census(0))
    await restartManagedHivewarddEnvironment('/u', 'env-1')
    expect(closes()).toEqual(FENCED)
  })

  it('never touches admission when the host lock is busy, so another update keeps its fence', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.lockBusy.current = true
    const result = await restartManagedHivewarddEnvironment('/u', 'env-1')
    expect(result.outcome).toBe('not-restarted')
    expect(closes()).toEqual([undefined])
  })

  it.each([
    ['a terminal opened before the recount', census(1), undefined],
    ['the stop was withdrawn', census(0), { state: 'withdrawn', reason: 'withdrawn' }]
  ])('reopens admission on the serving server when %s', async (_case, recount, stop) => {
    mocks.census.mockResolvedValueOnce(census(0)).mockResolvedValueOnce(recount)
    mocks.census.mockResolvedValue(census(0))
    if (stop) {
      mocks.stop.mockResolvedValue(stop)
    }
    await restartManagedHivewarddEnvironment('/u', 'env-1')
    expect(closes()).toEqual([...FENCED, 0])
  })

  it('leaves admission closed while the stop may still land', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.stop.mockResolvedValue({ state: 'unsettled', reason: 'still stopping' })
    await restartManagedHivewarddEnvironment('/u', 'env-1')
    expect(closes()).toEqual(FENCED)
  })

  it('leaves admission closed when the stop fails without saying whether it was sent', async () => {
    mocks.census.mockResolvedValue(census(0))
    mocks.stop.mockRejectedValue(new Error('SSH command timed out'))
    await expect(restartManagedHivewarddEnvironment('/u', 'env-1')).rejects.toThrow('timed out')
    expect(closes()).toEqual(FENCED)
  })

  it('stops nothing once the count may have outlived its fence', async () => {
    type Options = { closeAdmissionForMs?: number }
    mocks.census.mockImplementation(
      async (...args: [unknown, unknown, unknown, unknown, Options]) => {
        if (args[4]?.closeAdmissionForMs) {
          vi.setSystemTime(Date.now() + HIVEWARDD_UPDATE_ADMISSION_STOP_BY_MS + 1)
        }
        return census(0)
      }
    )
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const result = await restartManagedHivewarddEnvironment('/u', 'env-1')
      expect(result.outcome).toBe('not-restarted')
      expect(mocks.stop).not.toHaveBeenCalled()
      expect(closes()).toEqual([...FENCED, 0])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('readManagedHivewarddLaunchSshSession', () => {
  it('probes a macOS host’s active slot', async () => {
    mocks.exec.mockResolvedValue('EXITED\n')
    await expect(readManagedHivewarddLaunchSshSession('/u', 'env-1')).resolves.toBe('exited')
  })

  it('runs nothing on a Linux host', async () => {
    mocks.host.current = getRemoteHostPlatform('linux-x64')
    await expect(readManagedHivewarddLaunchSshSession('/u', 'env-1')).resolves.toBe('not-applicable')
    expect(mocks.exec).not.toHaveBeenCalled()
  })
})
