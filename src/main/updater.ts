import { countWorkingUpdateAgents } from './updater/hiveward-working-agents'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { UpdateStatus, UpdateCheckOptions } from '../shared/update-status-types'
import type { RemoteServerUpdaterSnapshot } from '../shared/remote-server-update'
import { hivewardProduct } from '../shared/hiveward-policy'
import { getMainHttpClient } from './network/http-client'
import { loadElectronAutoUpdater } from './electron-updater-loader'
import { mainProcessState } from './startup/main-process-state'
import {
  findHiveWardRelease,
  readMacReleaseArchive,
  downloadVerifiedArchive,
  type HiveWardRelease
} from './updater/hiveward-release'
import { prepareMacUpdate, launchMacInstaller } from './updater/hiveward-mac-installer'

export type PreQuitCleanupFailureMode = 'continue' | 'abort'
export type UpdateInstallMode =
  | 'interactive'
  | 'supervised-headless-serve'
  | 'unsupported-headless-serve'
export type UpdaterSetupOptions = {
  getMainWindow?: () => BrowserWindow | null
  onBeforeQuit?: () => void | Promise<void>
  onBeforeQuitFailure?: PreQuitCleanupFailureMode
  installMode?: UpdateInstallMode
  getAutomatic?: () => boolean
  setAutomatic?: (enabled: boolean) => void
}
export const HIVEWARD_CHECK_INTERVAL = 6 * 60 * 60 * 1000
let status: UpdateStatus = { state: 'idle' }
let release: HiveWardRelease | null = null
let options: UpdaterSetupOptions = {}
let initialized = false
let quitting = false
let busy = false
let prepared: { app: string; directory: string } | null = null
const fetchRelease = (url: string, init?: RequestInit) => getMainHttpClient().fetch(url, init)
const automatic = () => options.getAutomatic?.() ?? true
function publish(next: UpdateStatus): void {
  status = next
  const window = options.getMainWindow?.()
  if (window && !window.isDestroyed()) {
    window.webContents.send('updater:status', status)
  }
}
function failed(error: unknown): void {
  publish({ state: 'error', message: error instanceof Error ? error.message : String(error) })
}
export function getUpdateStatus(): UpdateStatus {
  return status
}
async function workingAgentCount(): Promise<number> {
  return mainProcessState.runtime
    ? countWorkingUpdateAgents(mainProcessState.runtime)
    : (mainProcessState.agentAwakeService?.getWorkingAgentCount() ?? 0)
}
export async function getHiveWardUpdateSnapshot() {
  return {
    appVersion: app.getVersion(),
    automatic: automatic(),
    status,
    notes: release?.notes ?? '',
    workingAgents: await workingAgentCount()
  }
}
export function setAutomaticUpdateChecks(enabled: boolean): void {
  if (!options.setAutomatic) {
    throw new Error('更新服务正在启动，请稍后再试')
  }
  options.setAutomatic(enabled)
}
export function isQuittingForUpdate(): boolean {
  return quitting
}
export function resolveUpdateInstallMode(isServeMode: boolean): UpdateInstallMode {
  return isServeMode ? 'unsupported-headless-serve' : 'interactive'
}
export async function checkForUpdatesFromMenu(_checkOptions?: UpdateCheckOptions): Promise<void> {
  if (busy || status.state === 'downloaded') {
    return
  }
  busy = true
  publish({ state: 'checking' })
  try {
    release = await findHiveWardRelease(app.getVersion(), fetchRelease)
    prepared = null
    publish(
      release
        ? {
            state: 'available',
            version: release.version,
            releaseUrl: release.url,
            changelog: {
              release: {
                title: release.version,
                description: release.notes,
                releaseNotesUrl: release.url
              },
              releasesBehind: null
            }
          }
        : { state: 'not-available' }
    )
  } catch (error) {
    failed(error)
  } finally {
    busy = false
  }
}
export function checkForUpdates(): void {
  void checkForUpdatesFromMenu()
}
export async function downloadUpdate(): Promise<void> {
  if (busy || !release || status.state === 'downloaded') {
    return
  }
  busy = true
  const selected = release
  publish({ state: 'downloading', version: selected.version, percent: 0 })
  try {
    if (!app.isPackaged) {
      throw new Error('开发环境不能安装更新')
    }
    if (process.platform === 'darwin') {
      const archive = await readMacReleaseArchive(selected, process.arch, fetchRelease)
      const directory = await mkdtemp(join(tmpdir(), 'hiveward-download-'))
      try {
        const zip = join(directory, 'update.zip')
        await downloadVerifiedArchive(archive, zip, fetchRelease, (percent) =>
          publish({ state: 'downloading', version: selected.version, percent })
        )
        prepared = await prepareMacUpdate(zip, selected.version, hivewardProduct.appId)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    } else if (process.platform === 'win32') {
      const updater = loadElectronAutoUpdater()
      updater.setFeedURL({ provider: 'github', owner: 'Chaunyzhang', repo: 'HiveWard' })
      updater.allowPrerelease = false
      updater.allowDowngrade = false
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
      const result = await updater.checkForUpdates()
      if (result?.updateInfo.version !== selected.version) {
        throw new Error('发布版本已变化，请重新检查更新')
      }
      await updater.downloadUpdate()
    } else {
      throw new Error('此平台请从 HiveWard Releases 手动更新')
    }
    publish({ state: 'downloaded', version: selected.version, releaseUrl: selected.url })
  } catch (error) {
    failed(error)
  } finally {
    busy = false
  }
}
export async function quitAndInstall(confirmation?: {
  version: string
  workingAgents: number
}): Promise<void> {
  if (busy || status.state !== 'downloaded' || !release || !app.isPackaged) {
    return
  }
  if (!initialized) {
    throw new Error('更新服务正在启动，请稍后再试')
  }
  const count = await workingAgentCount()
  if (busy) {
    return
  }
  if (
    !confirmation ||
    confirmation.version !== release.version ||
    confirmation.workingAgents !== count
  ) {
    throw new Error('工作状态已变化，请重新确认更新')
  }
  busy = true
  try {
    await options.onBeforeQuit?.()
    if (process.platform === 'darwin') {
      if (!prepared) {
        throw new Error('请重新下载更新')
      }
      await launchMacInstaller(prepared.app, prepared.directory, process.execPath)
      quitting = true
      app.quit()
    } else if (process.platform === 'win32') {
      quitting = true
      loadElectronAutoUpdater().quitAndInstall(false, true)
    }
  } catch (error) {
    quitting = false
    failed(error)
  } finally {
    busy = false
  }
}
export function setupAutoUpdater(_window: BrowserWindow | null, opts?: UpdaterSetupOptions): void {
  options = opts ?? {}
  if (initialized || !app.isPackaged || opts?.installMode === 'unsupported-headless-serve') {
    return
  }
  initialized = true
  if (automatic()) {
    checkForUpdates()
  }
  const timer = setInterval(() => {
    if (automatic()) {
      checkForUpdates()
    }
  }, HIVEWARD_CHECK_INTERVAL)
  timer.unref()
  app.once('will-quit', () => clearInterval(timer))
}
export function getRemoteServerUpdaterSnapshot(runtimeId: string): RemoteServerUpdaterSnapshot {
  return {
    appVersion: app.getVersion(),
    runtimeId,
    status,
    support: {
      installMode: 'unsupported-headless-serve',
      automatic: false,
      reason: 'manual-service-update-required'
    }
  }
}
export function checkForRemoteServerUpdate(
  runtimeId: string,
  _checkOptions?: UpdateCheckOptions
): RemoteServerUpdaterSnapshot {
  checkForUpdates()
  return getRemoteServerUpdaterSnapshot(runtimeId)
}
export function downloadRemoteServerUpdate(runtimeId: string): RemoteServerUpdaterSnapshot {
  void downloadUpdate()
  return getRemoteServerUpdaterSnapshot(runtimeId)
}
export function installRemoteServerUpdate(_runtimeId: string): never {
  throw new Error('请在要更新的 HiveWard 桌面上确认安装')
}
