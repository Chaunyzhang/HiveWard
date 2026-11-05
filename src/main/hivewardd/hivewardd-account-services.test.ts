import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { HiveWardRuntimeService } from '../runtime/hiveward-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../runtime/rpc/core'
import { ACCOUNT_METHODS } from '../runtime/rpc/methods/accounts'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { createHivewarddAccountServices } from './hivewardd-account-services'
import { USAGE_CREDENTIALS_RUNTIME_CAPABILITY } from '../../shared/account-runtime-capabilities'
import type { HivewarddRuntimeCleanup } from './hivewardd-runtime-lifetime'

const directories: string[] = []
const stores: Store[] = []
let cleanups: HivewarddRuntimeCleanup[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hivewardd-account-services-'))
  directories.push(directory)
  return directory
}

beforeEach(() => {
  // Isolate home/userData so account discovery cannot touch developer credentials.
  const home = tempDirectory()
  const userData = tempDirectory()
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  // Explicit host data root must win over inherited CI XDG configuration.
  vi.stubEnv('HIVEWARD_USER_DATA_PATH', userData)
  installFakeAppEnvironment({
    getPath: (name) => (name === 'home' ? home : name === 'temp' ? tmpdir() : userData)
  })
})

afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) {
    await cleanup({ failed: false })
  }
  cleanups = []
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createRuntime(): { runtime: HiveWardRuntimeService; store: Store } {
  const directory = tempDirectory()
  const store = new Store({
    dataFile: join(directory, 'hiveward-data.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(
      join(directory, 'profile-state.db'),
      'hivewardd-account-services'
    )
  })
  stores.push(store)
  return { runtime: new HiveWardRuntimeService(store), store }
}

const CLIENT_HOME = '/home/user/.local/share/hiveward/codex-accounts/client-account/home'

function create(store: Store, isWslHost: boolean): ReturnType<typeof createHivewarddAccountServices> {
  const clientHome = (launchEnv?: NodeJS.ProcessEnv): string | null =>
    launchEnv?.CODEX_HOME === CLIENT_HOME ? CLIENT_HOME : null
  return createHivewarddAccountServices({
    store,
    setClaudeStatusLineListener: vi.fn(),
    registerCleanup: (cleanup) => cleanups.push(cleanup),
    clientCodexHomes: {
      selectLaunchHome: async (_target, launchEnv) => clientHome(launchEnv),
      readLaunchHome: clientHome
    },
    isWslHost: () => isWslHost
  })
}

function install(
  runtime: HiveWardRuntimeService,
  store: Store,
  isWslHost: boolean
): ReturnType<typeof createHivewarddAccountServices> {
  const services = create(store, isWslHost)
  services?.attachToRuntime(runtime)
  return services
}

async function call(runtime: HiveWardRuntimeService, name: string, params: unknown): Promise<unknown> {
  const found = eraseRpcMethods(ACCOUNT_METHODS).find((candidate) => candidate.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`Missing request method ${name}`)
  }
  return found.handler(found.params ? found.params.parse(params) : params, { runtime })
}

describe('hivewardd account services', () => {
  it('serves accounts.* from this host', async () => {
    const { runtime, store } = createRuntime()
    expect(install(runtime, store, false)).not.toBeNull()
    expect(runtime.getUsageRateLimits()).not.toBeNull()
    expect(runtime.getStatus().capabilities).toContain(USAGE_CREDENTIALS_RUNTIME_CAPABILITY)

    await expect(call(runtime, 'accounts.list', { refreshUsage: false })).resolves.toMatchObject({
      claude: { accounts: [], activeAccountId: null },
      codex: { accounts: [], activeAccountId: null },
      rateLimits: expect.any(Object)
    })
    await expect(
      call(runtime, 'accounts.selectClaude', { accountId: null })
    ).resolves.toMatchObject({ activeAccountId: null })
    await expect(call(runtime, 'accounts.selectCodex', { accountId: null })).resolves.toMatchObject(
      {
        activeAccountId: null
      }
    )
  })

  it("resolves structured Codex launches to a client-sent home, else this host's selection", async () => {
    const { store } = createRuntime()
    const services = create(store, false)
    if (!services) {
      throw new Error('expected account services on a non-WSL host')
    }
    const { prepareCodexStructuredLaunch, resolveCodexStructuredLaunchHome } = services.runtimeDeps
    const clientEnv = { CODEX_HOME: CLIENT_HOME }

    await expect(prepareCodexStructuredLaunch({ launchEnv: clientEnv })).resolves.toBe(CLIENT_HOME)
    expect(resolveCodexStructuredLaunchHome({ launchEnv: clientEnv })).toBe(CLIENT_HOME)
    // Null selects the real default home, not ambient CODEX_HOME.
    await expect(prepareCodexStructuredLaunch({ launchEnv: {} })).resolves.toBeNull()
    expect(resolveCodexStructuredLaunchHome({ launchEnv: {} })).toBeNull()
    expect(services.listCodexSessionHomes()).toEqual(expect.any(Array))
  })

  it('prepares automatic Codex resumes on this host, but not for a client-sent home', async () => {
    const { store } = createRuntime()
    const services = create(store, false)
    if (!services) {
      throw new Error('expected account services on a non-WSL host')
    }
    const resume = (launchEnv: NodeJS.ProcessEnv) =>
      services.prepareCodexSessionResume({
        providerSession: { key: 'session_id', id: '019a0000-0000-7000-8000-000000000000' },
        target: { runtime: 'host' },
        launchEnv
      })

    await expect(resume({ CODEX_HOME: CLIENT_HOME })).resolves.toBeNull()
    await expect(resume({})).resolves.toMatchObject({ outcome: 'fresh' })
  })

  it('leaves a WSL host to the desktop that owns its accounts', async () => {
    const { runtime, store } = createRuntime()
    expect(install(runtime, store, true)).toBeNull()
    expect(runtime.getUsageRateLimits()).toBeNull()
    expect(runtime.getStatus().capabilities).not.toContain(USAGE_CREDENTIALS_RUNTIME_CAPABILITY)

    await expect(call(runtime, 'accounts.list', { refreshUsage: false })).rejects.toThrow(
      'Account services are not configured on this runtime'
    )
    expect(() =>
      runtime.setHostAccountLaunchEnv({ wslDistro: 'Ubuntu', claude: {}, terminal: {} })
    ).not.toThrow()
  })
})
