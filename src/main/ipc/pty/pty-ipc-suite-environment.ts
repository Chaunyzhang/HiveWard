import { afterEach, beforeEach, vi } from 'vitest'
import * as electron from 'electron'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import { setPtyHostBindings } from './pty-host-bindings'
import { testPtyIpcSurface } from './pty-ipc-test-surface'
import type { Mock } from 'vitest'
import {
  handleMock,
  onMock,
  removeHandlerMock,
  removeAllListenersMock,
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  readFileSyncMock,
  writeFileSyncMock,
  chmodSyncMock,
  linuxCliShimMock,
  getPathMock,
  loginPreflightExecFileMock,
  spawnMock,
  openCodeBuildPtyEnvMock,
  openCode2BuildPtyEnvMock,
  mimoCodeBuildPtyEnvMock,
  openCodeClearPtyMock,
  buildAgentHookEnvMock,
  clearAgentHookPaneStateMock,
  registerPaneKeyAliasMock,
  forgetRefusedPaneResumeMock,
  piBuildPtyEnvMock,
  piClearPtyMock,
  isPwshAvailableMock,
  wslUncDirectoryExistsAsyncMock,
  classifyErrorMock,
  registerPtyMock,
  unregisterPtyMock,
  setMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtysForPaneKeyMock,
  clearPaneKeyAliasesForPtyMock,
  recordCodexPaneAccountMock,
  forgetCodexPaneAccountMock,
  getCodexPaneAccountMock,
  ensureCodexBackfillRecoveryMock
} from './pty-ipc-mock-registry'
import { makeDisposable } from './pty-ipc-test-constants'
import { createPtyIpcProcessEnvScope } from './pty-ipc-process-env-scope'
import {
  LocalPtyProvider,
  _resetLocalPtyProviderStateForTest
} from '../../providers/local-pty/local-pty-provider'
import { setLocalPtyProvider } from './provider/registry'
import { _resetHiddenRendererPtyDeliveryGateForTest } from './delivery/pty-hidden-delivery-gate'
import { __resetShellStartupEnvCache } from '../../pty/shell-startup-env'
import { _resetWslCachesForTests } from '../../wsl'

export type PtyIpcTestWebContents = {
  id: number
  on: Mock
  send: Mock
  removeListener: Mock
  // WebContents may die before its window; model that liveness check explicitly (STA-2373, STA-5373).
  isDestroyed: Mock
}

export type PtyIpcTestMainWindow = {
  isDestroyed: () => boolean
  isFocused: () => boolean
  isVisible: () => boolean
  isMinimized: () => boolean
  webContents: PtyIpcTestWebContents
}

export type PtyIpcSuiteEnvironment = {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
  mainWindow: PtyIpcTestMainWindow
  mainWindowIpcEvent: { sender: PtyIpcTestWebContents }
  foreignWindowIpcEvent: { sender: PtyIpcTestWebContents }
}

export function createPtyIpcSuiteEnvironment(): PtyIpcSuiteEnvironment {
  const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
  const mainWindow = {
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: {
      id: 1,
      on: vi.fn(),
      send: vi.fn(),
      removeListener: vi.fn(),
      isDestroyed: vi.fn(() => false)
    }
  }
  const mainWindowIpcEvent = { sender: mainWindow.webContents }
  const foreignWindowIpcEvent = {
    sender: {
      id: 2,
      on: vi.fn(),
      send: vi.fn(),
      removeListener: vi.fn(),
      isDestroyed: vi.fn(() => false)
    }
  }
  const envScope = createPtyIpcProcessEnvScope()

  beforeEach(() => {
    // Capture registrations through the injected host port.
    setPtyHostBindings({ ipc: testPtyIpcSurface() })
    // Back AppEnvironment with the mutable Electron mock so mid-test isPackaged changes remain visible.
    const electronAppMock = (
      vi.mocked(electron) as unknown as {
        app: { isPackaged: boolean; getPath: (name: string) => string; getVersion: () => string }
      }
    ).app
    installFakeAppEnvironment({
      getPath: (name) => electronAppMock.getPath(name),
      isPackaged: () => electronAppMock.isPackaged,
      getVersion: () => electronAppMock.getVersion()
    })
    envScope.applyTestEnvDefaults()
    handlers.clear()
    handleMock.mockReset()
    onMock.mockReset()
    removeHandlerMock.mockReset()
    removeAllListenersMock.mockReset()
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    accessSyncMock.mockReset()
    mkdirSyncMock.mockReset()
    readFileSyncMock.mockReset()
    writeFileSyncMock.mockReset()
    chmodSyncMock.mockReset()
    linuxCliShimMock.mockReset()
    linuxCliShimMock.mockImplementation((options: { userDataPath: string }) =>
      join(options.userDataPath, 'linux-hiveward-cli-shim')
    )
    getPathMock.mockReset()
    loginPreflightExecFileMock.mockReset()
    spawnMock.mockReset()
    openCodeBuildPtyEnvMock.mockReset()
    openCode2BuildPtyEnvMock.mockReset()
    mimoCodeBuildPtyEnvMock.mockReset()
    openCodeClearPtyMock.mockReset()
    buildAgentHookEnvMock.mockReset()
    clearAgentHookPaneStateMock.mockReset()
    registerPaneKeyAliasMock.mockReset()
    forgetRefusedPaneResumeMock.mockReset()
    piBuildPtyEnvMock.mockReset()
    piClearPtyMock.mockReset()
    isPwshAvailableMock.mockReset()
    wslUncDirectoryExistsAsyncMock.mockReset()
    wslUncDirectoryExistsAsyncMock.mockResolvedValue(null)
    classifyErrorMock.mockReset()
    registerPtyMock.mockReset()
    unregisterPtyMock.mockReset()
    setMigrationUnsupportedPtyMock.mockReset()
    clearMigrationUnsupportedPtyMock.mockReset()
    clearMigrationUnsupportedPtysForPaneKeyMock.mockReset()
    clearPaneKeyAliasesForPtyMock.mockReset()
    recordCodexPaneAccountMock.mockReset()
    forgetCodexPaneAccountMock.mockReset()
    getCodexPaneAccountMock.mockReset()
    ensureCodexBackfillRecoveryMock.mockReset()
    ensureCodexBackfillRecoveryMock.mockResolvedValue(undefined)
    mainWindow.webContents.on.mockReset()
    mainWindow.webContents.send.mockReset()
    mainWindow.webContents.removeListener.mockReset()
    // Reset to explicitly alive; bare mockReset returns undefined and can hide missing liveness setup.
    mainWindow.webContents.isDestroyed.mockReset()
    mainWindow.webContents.isDestroyed.mockReturnValue(false)
    // Module-level PTY gate state must not leak between cases.
    _resetHiddenRendererPtyDeliveryGateForTest()
    __resetShellStartupEnvCache()

    // Mirror Electron's duplicate-channel rejection to catch missing removeHandler calls.
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      handlers.set(channel, handler)
    })
    removeHandlerMock.mockImplementation((channel: string) => {
      handlers.delete(channel)
    })
    // Model a live page by firing dispatcher-ready when the listener registers.
    onMock.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === 'pty:rendererDispatcherReady') {
        listener(mainWindowIpcEvent)
        // Clear the handshake flush before send-timing assertions.
        if (vi.isFakeTimers()) {
          vi.advanceTimersByTime(0)
        }
      }
    })
    getPathMock.mockReturnValue('/tmp/hiveward-user-data')
    // Wrapper roots must use the same userData path as the mocked app.
    process.env.HIVEWARD_USER_DATA_PATH = '/tmp/hiveward-user-data'
    existsSyncMock.mockReturnValue(true)
    // Generated shell wrapper validation rejects empty files.
    statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755, size: 1 })
    readFileSyncMock.mockReturnValue('')
    openCodeBuildPtyEnvMock.mockImplementation((_ptyId: string, existingConfigDir?: string) => ({
      HIVEWARD_OPENCODE_HOOK_PORT: '4567',
      HIVEWARD_OPENCODE_HOOK_TOKEN: 'opencode-token',
      HIVEWARD_OPENCODE_PTY_ID: 'test-pty',
      OPENCODE_CONFIG_DIR: existingConfigDir
        ? '/tmp/hiveward-opencode-overlay'
        : '/tmp/hiveward-opencode-config'
    }))
    openCode2BuildPtyEnvMock.mockImplementation((_ptyId: string, existingConfigDir?: string) => ({
      HIVEWARD_OPENCODE_HOOK_PORT: '4567',
      HIVEWARD_OPENCODE_HOOK_TOKEN: 'opencode2-token',
      HIVEWARD_OPENCODE_PTY_ID: 'test-pty',
      OPENCODE_CONFIG_DIR: existingConfigDir
        ? '/tmp/hiveward-opencode2-overlay'
        : '/tmp/hiveward-opencode2-config'
    }))
    mimoCodeBuildPtyEnvMock.mockImplementation((_ptyId: string, existingConfigDir?: string) => ({
      MIMOCODE_CONFIG_DIR: existingConfigDir
        ? '/tmp/hiveward-mimocode-overlay'
        : '/tmp/hiveward-mimocode-shared'
    }))
    buildAgentHookEnvMock.mockReturnValue({
      HIVEWARD_AGENT_HOOK_PORT: '5678',
      HIVEWARD_AGENT_HOOK_TOKEN: 'agent-token'
    })
    piBuildPtyEnvMock.mockImplementation(
      (
        _ptyId: string,
        existingAgentDir?: string,
        kind?: string,
        options?: { materializeDefaultHome?: boolean }
      ) => {
        const materializeDefaultHome = options?.materializeDefaultHome !== false
        if (kind === 'omp') {
          // Bare shells keep OMP status under userData without creating ~/.omp (#10196).
          if (!existingAgentDir && !materializeDefaultHome) {
            return {
              HIVEWARD_OMP_STATUS_EXTENSION:
                '/tmp/hiveward-user-data/omp-managed-status-extension/hiveward-agent-status.ts'
            }
          }
          return {
            HIVEWARD_OMP_SOURCE_AGENT_DIR: existingAgentDir ?? '/tmp/default-omp-agent',
            HIVEWARD_OMP_STATUS_EXTENSION: `${existingAgentDir ?? '/tmp/default-omp-agent'}/extensions/hiveward-agent-status.ts`
          }
        }
        if (kind === 'prime-agent') {
          if (!existingAgentDir && !materializeDefaultHome) {
            return {}
          }
          return {
            HIVEWARD_PRIME_AGENT_SOURCE_AGENT_DIR: existingAgentDir ?? '/tmp/default-prime-agent'
          }
        }
        if (!existingAgentDir && !materializeDefaultHome) {
          return {}
        }
        return {
          HIVEWARD_PI_SOURCE_AGENT_DIR: existingAgentDir ?? '/tmp/default-pi-agent'
        }
      }
    )
    isPwshAvailableMock.mockReturnValue(false)
    spawnMock.mockReturnValue({
      onData: vi.fn(() => makeDisposable()),
      onExit: vi.fn(() => makeDisposable()),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      process: 'zsh',
      pid: 12345
    })
  })

  afterEach(() => {
    _resetLocalPtyProviderStateForTest()
    _resetWslCachesForTests()
    vi.useRealTimers()
    setLocalPtyProvider(new LocalPtyProvider())
    envScope.restoreProcessEnv()
  })

  return { handlers, mainWindow, mainWindowIpcEvent, foreignWindowIpcEvent }
}
