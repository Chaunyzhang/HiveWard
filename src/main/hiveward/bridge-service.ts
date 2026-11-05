import { compatibleDataDirectory } from '../../shared/hiveward-profile-paths'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { hivewardMigrationNotices } from '../startup/hiveward-profile-migration'
import {
  getHiveWardUpdateSnapshot,
  checkForUpdatesFromMenu,
  downloadUpdate,
  quitAndInstall,
  setAutomaticUpdateChecks
} from '../updater'
import { readWindowsProcessTable } from '../windows/windows-process-table'
import { captureExitRegionEnvironment } from './exit-region-environment'
import { notifyExitRegionWarning } from './exit-region-notification'
import { notifyMachineInvitation } from './machine-invitation-notification'
import { createHiveWardClipboardAdapter } from './clipboard-adapter'
import { notifyClipboardNotice } from './clipboard-notification'
import { showMainWindowFromTray } from '../startup/main-window-actions'
import { WebSocketServer, WebSocket } from 'ws'
import { openHiveWardTerminalStream } from './terminal-stream'
import { mainProcessState } from '../startup/main-process-state'
import { app, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { isBlockedVendorUrl } from '../../shared/hiveward-policy'
import type { ComputerAwakeMode, ComputerAwakeStatus } from '../../shared/computer-awake-mode'
import type { RateLimitState } from '../../shared/rate-limit-types'
import { installBrowserSessionUserAgentPolicy } from '../browser/browser-session-ua'
import { acquireElectronDebugger } from '../browser/electron-debugger-lease'
import { createDesktopPopupHandler } from './desktop-popup-policy'

type CockpitService = {
  close: () => Promise<void>
  navigate: (path: string) => boolean
  contents: () => WebContents | null
}
let service: CockpitService | null = null
let usageFetched = false

export async function startHiveWardBridge(window: BrowserWindow): Promise<void> {
  if (service) {
    return
  }
  const root = app.isPackaged
    ? join(process.resourcesPath, 'hiveward')
    : join(app.getAppPath(), 'hiveward')
  const module: {
    startCockpit: (options: {
      migrationNotices: ReturnType<typeof hivewardMigrationNotices>
      windowsProcesses: typeof readWindowsProcessTable
      onMachineInvite: typeof notifyMachineInvitation
      captureExitEnvironment: typeof captureExitRegionEnvironment
      onExitRegionWarning: typeof notifyExitRegionWarning
      clipboardAdapter: ReturnType<typeof createHiveWardClipboardAdapter>
      onClipboardNotice: typeof notifyClipboardNotice
      computerAwake: {
        getStatus: () => ComputerAwakeStatus
        setMode: (mode: ComputerAwakeMode) => void
      }
      updates: {
        snapshot: typeof getHiveWardUpdateSnapshot
        check: typeof checkForUpdatesFromMenu
        download: typeof downloadUpdate
        install: typeof quitAndInstall
        setAutomatic: typeof setAutomaticUpdateChecks
      }
      usage: {
        getState: () => RateLimitState | null
        refresh: () => Promise<RateLimitState | null>
      }
      terminalStreaming: {
        open: typeof openHiveWardTerminalStream
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
      installSessionUserAgent: typeof installBrowserSessionUserAgentPolicy
      acquireDebugger: typeof acquireElectronDebugger
      createPopupHandler: typeof createDesktopPopupHandler
    }) => Promise<CockpitService>
  } = await import(/* @vite-ignore */ pathToFileURL(join(root, 'desktop/engine.mjs')).href)
  service = await module.startCockpit({
    migrationNotices: hivewardMigrationNotices(),
    window,
    updates: {
      snapshot: getHiveWardUpdateSnapshot,
      check: checkForUpdatesFromMenu,
      download: downloadUpdate,
      install: quitAndInstall,
      setAutomatic: setAutomaticUpdateChecks
    },
    windowsProcesses: readWindowsProcessTable,
    onMachineInvite: notifyMachineInvitation,
    captureExitEnvironment: captureExitRegionEnvironment,
    onExitRegionWarning: notifyExitRegionWarning,
    clipboardAdapter: createHiveWardClipboardAdapter(),
    onClipboardNotice: notifyClipboardNotice,
    // Resolved per call: the service is torn down on quit.
    computerAwake: {
      getStatus: () =>
        mainProcessState.agentAwakeService?.getStatus() ?? { mode: 'off', active: false },
      setMode: (mode) => mainProcessState.agentAwakeService?.setMode(mode)
    },
    // 各家 Agent 的用量（5 小时 / 每周额度），和 HiveWard 状态栏同一份；设置 → 用量里看。
    // 不在后台轮询：第一次打开「用量」时取一次，之后老板点「刷新」才再取
    usage: {
      getState: () => {
        const rateLimits = mainProcessState.rateLimits
        if (rateLimits && !usageFetched) {
          usageFetched = true
          void rateLimits.refresh().catch((error: unknown) => {
            console.warn('[hiveward] usage refresh failed', error)
          })
        }
        return rateLimits?.getState() ?? null
      },
      refresh: async () => {
        usageFetched = true
        return (await mainProcessState.rateLimits?.refresh()) ?? null
      }
    },
    terminalStreaming: { open: openHiveWardTerminalStream, WebSocketServer, WebSocket },
    getMainWindow: () => mainProcessState.mainWindow,
    isBlockedUrl: isBlockedVendorUrl,
    installSessionUserAgent: installBrowserSessionUserAgentPolicy,
    acquireDebugger: acquireElectronDebugger,
    createPopupHandler: createDesktopPopupHandler,
    root,
    metadataPath: getRuntimeMetadataPath(getCanonicalUserDataPath()),
    dataPath: compatibleDataDirectory(getCanonicalUserDataPath()),
    staticDir: app.isPackaged
      ? join(root, 'web')
      : join(app.getAppPath(), '.hiveward-build/cockpit/dist'),
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

export async function stopHiveWardBridge(): Promise<void> {
  const current = service
  service = null
  await current?.close()
}
