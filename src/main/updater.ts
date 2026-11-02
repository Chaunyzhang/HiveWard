import { vendorServicesEnabled } from '../shared/opc-policy'
import type { BrowserWindow } from 'electron'
import type {
  LinuxPackageInstallInstructions,
  UpdateCheckOptions,
  UpdateStatus
} from '../shared/update-status-types'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot,
  RemoteServerUpdateSupport
} from '../shared/remote-server-update'
import type { ReleaseBuild, ReleaseChannel } from '../shared/release-channel'
import type { ReleaseBuildListOptions } from './updater-release-build-cache'
import { UpdaterSetup, type UpdaterSetupOptions } from './updater/updater-setup'
import type { PreQuitCleanupFailureMode, UpdateInstallMode } from './updater/updater-state'

const updater = new UpdaterSetup()

export type { PreQuitCleanupFailureMode, UpdateInstallMode, UpdaterSetupOptions }

export function resolveUpdateInstallMode(isServeMode: boolean): UpdateInstallMode {
  return updater.resolveUpdateInstallMode(isServeMode)
}

export function getUpdateStatus(): UpdateStatus {
  return updater.getUpdateStatus()
}

export function getRemoteServerUpdateSupport(): RemoteServerUpdateSupport {
  return updater.getRemoteServerUpdateSupport()
}

export function getRemoteServerUpdaterSnapshot(runtimeId: string): RemoteServerUpdaterSnapshot {
  return updater.getRemoteServerUpdaterSnapshot(runtimeId)
}

export function checkForRemoteServerUpdate(
  runtimeId: string,
  options?: UpdateCheckOptions
): RemoteServerUpdaterSnapshot {
  if (!vendorServicesEnabled) {
    throw new Error('Updates are disabled in OPC.')
  }
  return updater.checkForRemoteServerUpdate(runtimeId, options)
}

export function downloadRemoteServerUpdate(runtimeId: string): RemoteServerUpdaterSnapshot {
  if (!vendorServicesEnabled) {
    throw new Error('Updates are disabled in OPC.')
  }
  return updater.downloadRemoteServerUpdate(runtimeId)
}

export function installRemoteServerUpdate(runtimeId: string): RemoteServerUpdateInstallResult {
  if (!vendorServicesEnabled) {
    throw new Error('Updates are disabled in OPC.')
  }
  return updater.installRemoteServerUpdate(runtimeId)
}

export function checkForUpdates(): void {
  if (!vendorServicesEnabled) {
    return
  }
  updater.checkForUpdates()
}

export function checkForUpdatesFromMenu(options?: UpdateCheckOptions): void {
  if (!vendorServicesEnabled) {
    return
  }
  updater.checkForUpdatesFromMenu(options)
}

export function downloadUpdate(): void {
  if (!vendorServicesEnabled) {
    return
  }
  updater.downloadUpdate()
}

export function quitAndInstall(): void {
  if (!vendorServicesEnabled) {
    return
  }
  updater.quitAndInstall()
}

export function isQuittingForUpdate(): boolean {
  return updater.isQuittingForUpdate()
}

export async function getLinuxPackageInstallInstructions(): Promise<LinuxPackageInstallInstructions> {
  return updater.getLinuxPackageInstallInstructions()
}

export async function showLinuxPackage(): Promise<void> {
  return updater.showLinuxPackage()
}

export async function listAvailableReleaseBuilds(
  channel: ReleaseChannel,
  options?: ReleaseBuildListOptions
): Promise<ReleaseBuild[]> {
  if (!vendorServicesEnabled) {
    throw new Error('Updates are disabled in OPC.')
  }
  return updater.listAvailableReleaseBuilds(channel, options)
}

export function dismissNudge(): void {
  updater.dismissNudge()
}

export function dismissAvailableUpdate(): void {
  updater.dismissAvailableUpdate()
}

export function setupAutoUpdater(
  mainWindow: BrowserWindow | null,
  opts?: UpdaterSetupOptions
): void {
  if (!vendorServicesEnabled) {
    return
  }
  updater.setupAutoUpdater(mainWindow, opts)
}
