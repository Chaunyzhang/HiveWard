import {
  checkForUpdatesFromMenu,
  downloadUpdate,
  getUpdateStatus,
  setupAutoUpdater,
  type PreQuitCleanupFailureMode,
  type UpdateInstallMode
} from '../updater'
import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { getTrustedUIRendererWindow, isTrustedUIRenderer } from '../ipc/ui'
import type { Store } from '../persistence/loading-store/store'
import { applyProxyToElectronUpdaterSession } from '../updater/electron-updater-proxy-session'

type UpdaterSetupHooks = {
  onBeforeUpdateQuit?: () => void | Promise<void>
  onBeforeUpdateQuitFailure?: PreQuitCleanupFailureMode
  updateInstallMode?: UpdateInstallMode
}
let pending: (() => void) | null = null
export function ensureAutoUpdaterConfigured(): void {
  pending?.()
}
function setup(window: BrowserWindow | null, store: Store, hooks?: UpdaterSetupHooks): void {
  void applyProxyToElectronUpdaterSession(store.getSettings())
    .then(() =>
      setupAutoUpdater(window, {
        getMainWindow: getTrustedUIRendererWindow,
        getAutomatic: () => store.getSettings().automaticUpdateChecks !== false,
        setAutomatic: (enabled) => {
          store.updateSettings({ automaticUpdateChecks: enabled })
        },
        installMode: hooks?.updateInstallMode,
        onBeforeQuit: async () => {
          await hooks?.onBeforeUpdateQuit?.()
          await store.flushPendingAsync()
        }
      })
    )
    .catch((error) => console.error('[updater]', error))
}
export function setupHeadlessServeAutoUpdater(store: Store, hooks: UpdaterSetupHooks): void {
  setup(null, store, { ...hooks, updateInstallMode: 'unsupported-headless-serve' })
}
export function scheduleMainWindowAutoUpdaterSetup(
  window: BrowserWindow,
  store: Store,
  hooks?: UpdaterSetupHooks
): void {
  const start = () => {
    if (pending !== start) {
      return
    }
    pending = null
    setup(window, store, hooks)
  }
  pending = start
  window.once('ready-to-show', start)
  const fallback = setTimeout(start, 15_000)
  fallback.unref()
}
export function registerUpdaterHandlers(_store: Store): void {
  const handlers = {
    'updater:getStatus': getUpdateStatus,
    'updater:check': () => {
      ensureAutoUpdaterConfigured()
      return checkForUpdatesFromMenu()
    },
    'updater:download': downloadUpdate,
    'updater:getVersion': () => app.getVersion()
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(name)
    ipcMain.handle(name, (event) => {
      if (!isTrustedUIRenderer(event.sender)) {
        throw new Error('不允许的更新请求')
      }
      return handler()
    })
  }
}
