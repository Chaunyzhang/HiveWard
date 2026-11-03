import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { opcProduct } from '../../shared/opc-policy'
import { getAppIconPath } from '../app-icon'
import type { Store } from '../persistence/loading-store/store'
import type { CreateMainWindowOptions, MainWindowLoadObserver } from './main-window-contracts'
import { installMainWindowStateLifecycle } from './main-window-state-lifecycle'
import { rectHasVisibleAreaOnAnyDisplay } from './window-bounds-validation'
import { MIN_HEIGHT, MIN_WIDTH } from './main-window-visual-lifecycle'

export function loadMainWindow(window: BrowserWindow, observer?: MainWindowLoadObserver): void {
  const origin = process.env.OPC_BRIDGE ?? `http://127.0.0.1:${process.env.OPC_PORT ?? 47615}`
  void window.loadURL(origin).then(
    () => observer?.onLoaded?.(),
    (error) => observer?.onError?.(error)
  )
}

export function createMainWindow(
  store: Store | null,
  opts?: CreateMainWindowOptions
): BrowserWindow {
  const saved = store?.getUI().windowBounds
  const bounds =
    saved &&
    saved.width >= MIN_WIDTH &&
    saved.height >= MIN_HEIGHT &&
    rectHasVisibleAreaOnAnyDisplay(saved, MIN_WIDTH / 2, MIN_HEIGHT / 2)
      ? saved
      : screen.getPrimaryDisplay().workAreaSize
  const root = app.isPackaged ? join(process.resourcesPath, 'opc') : join(app.getAppPath(), 'opc')
  const window = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: opts?.title ?? opcProduct.name,
    show: false,
    acceptFirstMouse: true,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    icon: getAppIconPath(store?.getSettings().appIcon),
    webPreferences: {
      preload: join(root, 'desktop/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      partition: 'persist:opc-cockpit',
      backgroundThrottling: false
    }
  })
  const lifecycle = installMainWindowStateLifecycle({
    mainWindow: window,
    revealOnDidFinishLoad: true,
    savedMaximized: store?.getUI().windowMaximized ?? false,
    store
  })
  window.on('page-title-updated', (event) => event.preventDefault())
  window.on('close', (event) => {
    if (
      process.platform === 'win32' &&
      !opts?.getIsQuitting?.() &&
      store?.getSettings().minimizeToTrayOnClose
    ) {
      event.preventDefault()
      window.hide()
      return
    }
    lifecycle.freezeBoundsOnQuit()
  })
  window.on('closed', () => lifecycle.dispose())
  if (!opts?.deferLoad) {
    loadMainWindow(window)
  }
  return window
}
