import {
  app,
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type Tray
} from 'electron'
import type { UpdateCheckOptions } from '../../shared/update-status-types'
import type { AppMenuQuitHandlers } from '../menu/app-menu-quit-item'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { checkForUpdatesFromMenu, isQuittingForUpdate } from '../updater'
import {
  createSystemTray,
  setMacMenuBarIconVisible,
  type SystemTrayOptions
} from '../tray/system-tray'
import { ensureAutoUpdaterConfigured } from '../window/main-window-updater'
import { focusExistingMainWindow, safelyRevealWindow } from '../window/focus-existing-window'
import { mainProcessState as state } from './main-process-state'
import { openInHiveWard } from '../opc/bridge-service'
import { markUserQuitWindowClose } from '../window/user-quit-window-close'
import { isBlockingInstallDirAclRepairInFlight } from './windows-install-dir-acl-recovery'
import {
  confirmQuitAndStopAllSessions,
  explainStopAllSessionsUnavailable
} from './quit-and-stop-all-sessions-prompt'
import { isHoldingForNewerProtocolDaemon } from '../daemon/daemon-newer-protocol-hold'
import { getDaemonProvider } from '../daemon/daemon-provider-state'
import { confirmNoDaemonSessionsRemain, killAllDaemonSessions } from '../ipc/pty/pty-management'

// Inject the opener to avoid an actions/lifecycle import cycle.
let openWindow: (options?: { revealOnDidFinishLoad?: boolean }) => BrowserWindow
export function setMainWindowOpener(
  opener: (options?: { revealOnDidFinishLoad?: boolean }) => BrowserWindow
): void {
  openWindow = opener
}

export function focusExistingWindow(): void {
  focusExistingMainWindow({
    app,
    getWindow: () => state.mainWindow,
    openWindow,
    // Repair rewrites renderer DACLs; second-click activation during a blank launch must wait for the gated opener.
    canOpenWindow: () => !isBlockingInstallDirAclRepairInFlight(),
    warn: console.warn
  })
}

export function showMainWindowFromTray(): void {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    safelyRevealWindow(state.mainWindow)
    return
  }
  if (!isQuittingForUpdate()) {
    openWindow()
  }
}

export function openSettingsFromSystemMenu(): void {
  // HiveWard 是唯一界面：打开 HiveWard 的设置页，不切 Orca 界面的设置
  if (openInHiveWard('/settings')) {
    recordCrashBreadcrumb('settings_opened')
  }
}

/** On serve, user Quit closes desktop windows while paired clients keep the server (#15537); signals/supervisor/updates still quit the process. */
export function quitFromUserCommand(): void {
  if (state.isServeMode) {
    // Offscreen automation windows belong to the runtime and must survive desktop-window close.
    for (const window of [state.mainWindow]) {
      if (window && !window.isDestroyed()) {
        if (window === state.mainWindow) {
          markUserQuitWindowClose(window)
        }
        window.close()
      }
    }
    return
  }
  state.isQuitting = true
  app.quit()
}

export function quitFromSystemTray(): void {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    showMainWindowFromTray()
  }
  quitFromUserCommand()
}

let quitAndStopAllSessionsConfirming = false

function showMessageBoxOnMainWindow(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const window = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
}

export function quitAndStopAllSessionsFromUserCommand(): void {
  // Why: under orca serve a user Quit only closes the windows (#15537), so this would never quit.
  if (state.isServeMode || quitAndStopAllSessionsConfirming) {
    return
  }
  quitAndStopAllSessionsConfirming = true
  // Why reveal first: the dialog is a sheet on this window, invisible while it is minimized or hidden.
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    showMainWindowFromTray()
  }
  // Why before asking: without a daemon provider (starting or failed) or with a newer version's daemon held,
  // Kill all can't list every session, so it would close every tab and then refuse.
  const ask: typeof confirmQuitAndStopAllSessions =
    getDaemonProvider() && !isHoldingForNewerProtocolDaemon()
      ? confirmQuitAndStopAllSessions
      : explainStopAllSessionsUnavailable
  void ask(showMessageBoxOnMainWindow)
    .then(async (confirmed) => {
      if (!confirmed || !state.runtime) {
        return
      }
      state.automations?.stop()
      const { terminals } = await state.runtime.listTerminals()
      for (const terminal of terminals) {
        await state.runtime.closeTerminal(terminal.handle)
      }
      const result = await killAllDaemonSessions()
      if (result.listingIncomplete || !(await confirmNoDaemonSessionsRemain())) {
        throw new Error('Some terminal sessions could not be stopped')
      }
      quitFromUserCommand()
    })
    .catch((error) => console.error('[quit] Quit Completely failed:', error))
    .finally(() => {
      quitAndStopAllSessionsConfirming = false
    })
}

export function runUserInitiatedUpdateCheck(options?: UpdateCheckOptions): void {
  ensureAutoUpdaterConfigured()
  checkForUpdatesFromMenu(options)
}

export function getSystemTrayOptions(): SystemTrayOptions | null {
  const store = state.store
  if (!store) {
    return null
  }
  return {
    appIcon: store.getSettings().appIcon,
    isDevInstance: state.devInstanceIdentity?.isDev ?? false,
    devInstanceLabel: state.devInstanceIdentity?.devLabel ?? null,
    onOpen: showMainWindowFromTray,
    onOpenSettings: openSettingsFromSystemMenu,
    onCheckForUpdates: () => {
      showMainWindowFromTray()
      runUserInitiatedUpdateCheck()
    },
    onQuit: quitFromSystemTray,
    ...(state.isServeMode
      ? {}
      : { onQuitAndStopAllSessions: quitAndStopAllSessionsFromUserCommand })
  }
}

export function getAppMenuQuitHandlers(): AppMenuQuitHandlers {
  return state.isServeMode
    ? { onQuit: quitFromUserCommand }
    : { onQuitAndStopAllSessions: quitAndStopAllSessionsFromUserCommand }
}

export function syncMacMenuBarIcon(showMenuBarIcon: boolean): Tray | null {
  if (process.platform !== 'darwin' || state.isServeMode) {
    return null
  }
  const options = getSystemTrayOptions()
  return options ? setMacMenuBarIconVisible(showMenuBarIcon, options) : null
}

export function createSystemTrayDeferred(
  window: BrowserWindow,
  onCreated?: () => void
): () => void {
  let trayCreated = false
  return () => {
    if (trayCreated || window.isDestroyed() || state.isQuitting || !state.store) {
      return
    }
    trayCreated = true
    if (process.platform === 'darwin') {
      if (syncMacMenuBarIcon(state.store.getSettings().showMenuBarIcon !== false)) {
        onCreated?.()
      }
      return
    }
    const options = getSystemTrayOptions()
    if (options && createSystemTray(options)) {
      onCreated?.()
    }
  }
}
