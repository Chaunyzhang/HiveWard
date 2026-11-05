import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/hivewardd-managed-launch-env'
import { bindHivewarddIdleShutdown, beginHivewarddIdleExit } from './hivewardd-managed-idle-exit-host'
import { installHivewarddManagedIdleExit } from './hivewardd-managed-idle-exit'
import type * as ManagedIdleExit from './hivewardd-managed-idle-exit'
import type * as DaemonProviderState from '../daemon/daemon-provider-state'
import { retireHivewarddDaemonIfIdle } from './hivewardd-daemon-retirement'
import { discardHivewarddIdleStopRecord } from './hivewardd-idle-stop-record'
import { restartDaemon } from '../daemon/daemon-provider-restart'

const { hasLoadedProviders } = vi.hoisted(() => ({ hasLoadedProviders: vi.fn(() => false) }))

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ hasLoadedProviders })
}))
vi.mock('../ipc/pty/provider/registry', () => ({
  getLocalPtyProvider: () => ({ listProcesses: async () => [] })
}))
vi.mock('../daemon/daemon-init', () => ({ getDaemonEndpointFacts: () => null }))
vi.mock('./hivewardd-daemon-retirement', () => ({
  countLiveHivewarddDaemonSessions: vi.fn(async () => 0),
  retireHivewarddDaemonIfIdle: vi.fn()
}))
vi.mock('../daemon/daemon-provider-state', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonProviderState>()),
  getCurrentDaemonPid: () => 4242
}))
vi.mock('../daemon/daemon-provider-restart', () => ({ restartDaemon: vi.fn(async () => ({})) }))
vi.mock('./hivewardd-idle-stop-record', () => ({
  consumeHivewarddIdleStopRecord: vi.fn(() => null),
  discardHivewarddIdleStopRecord: vi.fn(),
  writeHivewarddIdleStopRecord: vi.fn()
}))
vi.mock('./hivewardd-managed-idle-exit', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedIdleExit>()),
  installHivewarddManagedIdleExit: vi.fn(() => () => {})
}))

beforeEach(() => {
  vi.clearAllMocks()
  hasLoadedProviders.mockReturnValue(false)
  vi.stubEnv(HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV, 'test-fence')
})

afterEach(() => vi.unstubAllEnvs())

it.each(['provider', 'client', 'request', 'recent request'])(
  'rechecks a returning %s after daemon retirement before requesting an idle shutdown',
  async (returning) => {
    const activity = { openConnections: 0, requestsInFlight: 0, lastRequestAt: 0 }
    const retire = Promise.withResolvers<{ retirement: string; reason: null }>()
    vi.mocked(retireHivewarddDaemonIfIdle).mockImplementationOnce(async () => ({
      ...(await retire.promise),
      retirement: 'retired',
      liveSessions: 0
    }))
    const shutdown = vi.fn(() => true)
    bindHivewarddIdleShutdown(shutdown)
    await beginHivewarddIdleExit('test-profile').start({
      rpc: {
        readClientActivity: () => activity
      },
      agentStates: () => [],
      hasStagedMigration: () => false,
      automationsBusy: () => false,
      emulatorsBusy: async () => false,
      registerCleanup: () => {}
    })
    const installed = vi.mocked(installHivewarddManagedIdleExit).mock.calls.at(-1)?.[0]
    if (!installed) {
      throw new Error('idle monitor was not installed')
    }
    const stopping = installed.stop({ quietSince: 0, stoppedAt: 900_000, timeoutMs: 900_000 })
    hasLoadedProviders.mockReturnValue(returning === 'provider')
    activity.openConnections = returning === 'client' ? 1 : 0
    activity.requestsInFlight = returning === 'request' ? 1 : 0
    activity.lastRequestAt = returning === 'recent request' ? 1 : 0
    retire.resolve({ retirement: 'retired', reason: null })

    expect(await stopping).toBe(false)
    expect(shutdown).not.toHaveBeenCalled()
    expect(discardHivewarddIdleStopRecord).toHaveBeenCalledWith('test-profile')
    expect(restartDaemon).toHaveBeenCalledOnce()
  }
)
