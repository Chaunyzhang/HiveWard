import { app, type BrowserWindow } from 'electron'
import { createMainWindow } from '../window/createMainWindow'
import { createSystemTrayDeferred } from './main-window-actions'
import { mainProcessState as state } from './main-process-state'
import { setTrayAttention } from '../tray/system-tray'
import { notifyMainWindowBecameVisible } from '../window/main-window-visibility'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'

export function openMainWindow(options: { revealOnDidFinishLoad?: boolean } = {}): BrowserWindow {
  if (!state.store || !state.runtime) {
    throw new Error('Runtime not initialized')
  }
  const window = createMainWindow(state.store, {
    ...options,
    deferLoad: true,
    getIsQuitting: () => state.isQuitting,
    title: state.devInstanceIdentity?.name ?? app.name
  })
  state.mainWindow = window
  state.hasOpenedMainWindow = true
  const createTray = createSystemTrayDeferred(window, () => {})
  window.once('ready-to-show', createTray)
  const trayTimer = setTimeout(createTray, 12000)
  trayTimer.unref()
  window.on('show', () => {
    notifyMainWindowBecameVisible()
    setTrayAttention(false)
  })
  window.on('closed', () => {
    clearTimeout(trayTimer)
    if (state.mainWindow === window) {
      state.mainWindow = null
    }
  })
  recordCrashBreadcrumb('main_window_created')
  return window
}
