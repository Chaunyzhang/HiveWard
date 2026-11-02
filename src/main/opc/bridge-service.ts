import { captureExitRegionEnvironment } from './exit-region-environment'
import { notifyExitRegionWarning } from './exit-region-notification'
import { notifyMachineInvitation } from './machine-invitation-notification'
import { showMainWindowFromTray } from '../startup/main-window-actions'
import { WebSocketServer, WebSocket } from 'ws'
import { openOpcTerminalStream } from './terminal-stream'
import { mainProcessState } from '../startup/main-process-state'
import { app, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { isBlockedVendorUrl, opcProduct } from '../../shared/opc-policy'

type CockpitService = {
  close: () => Promise<void>
  navigate: (path: string) => boolean
  contents: () => WebContents | null
}
let service: CockpitService | null = null

export async function startOpcBridge(window: BrowserWindow): Promise<void> {
  if (service) {
    return
  }
  const root = app.isPackaged ? join(process.resourcesPath, 'opc') : join(app.getAppPath(), 'opc')
  const module: {
    startCockpit: (options: {
      onMachineInvite: typeof notifyMachineInvitation
      captureExitEnvironment: typeof captureExitRegionEnvironment
      onExitRegionWarning: typeof notifyExitRegionWarning
      terminalStreaming: {
        open: typeof openOpcTerminalStream
        WebSocketServer: typeof WebSocketServer
        WebSocket: typeof WebSocket
      }
      window: BrowserWindow
      root: string
      metadataPath: string
      dataPath: string
      staticDir: string
      development: boolean
      getMainWindow: () => BrowserWindow | null
      isBlockedUrl: (url: string) => boolean
    }) => Promise<CockpitService>
  } = await import(/* @vite-ignore */ pathToFileURL(join(root, 'desktop/engine.mjs')).href)
  service = await module.startCockpit({
    window,
    onMachineInvite: notifyMachineInvitation,
    captureExitEnvironment: captureExitRegionEnvironment,
    onExitRegionWarning: notifyExitRegionWarning,
    terminalStreaming: { open: openOpcTerminalStream, WebSocketServer, WebSocket },
    getMainWindow: () => mainProcessState.mainWindow,
    isBlockedUrl: isBlockedVendorUrl,
    root,
    metadataPath: join(getCanonicalUserDataPath(), opcProduct.runtimeMetadata),
    dataPath: join(getCanonicalUserDataPath(), 'opc-data'),
    staticDir: app.isPackaged
      ? join(root, 'web')
      : join(app.getAppPath(), '.opc-build/cockpit/dist'),
    development: !app.isPackaged
  })
}

/** HiveWard 网页（唯一界面）的 webContents；还没起来时为 null */
export function hivewardContents(): WebContents | null {
  return service?.contents() ?? null
}

/** 把 HiveWard 切到站内某个页面并把窗口叫到前面；HiveWard 还没起来时返回 false */
export function openInHiveWard(path: string): boolean {
  if (!service) {
    return false
  }
  if (service.navigate(path)) {
    return true
  }
  showMainWindowFromTray()
  const window = mainProcessState.mainWindow
  if (!window || window.isDestroyed()) {
    return false
  }
  window.webContents.once('did-finish-load', () => service?.navigate(path))
  return true
}

export async function stopOpcBridge(): Promise<void> {
  const current = service
  service = null
  await current?.close()
}
