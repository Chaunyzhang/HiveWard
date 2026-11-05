import { BrowserWindow } from 'electron'
import {
  HIVEWARD_PROFILE_AUTH_STATUS_CHANGED_CHANNEL,
  HIVEWARD_PROFILE_SIGN_IN_PROGRESS_CHANGED_CHANNEL,
  type HiveWardCloudSignInProgress
} from '../../shared/hiveward-profiles'

function broadcast(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(channel, ...args)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

export function broadcastHiveWardProfileAuthStatusChanged(): void {
  broadcast(HIVEWARD_PROFILE_AUTH_STATUS_CHANGED_CHANNEL)
}

export function broadcastHiveWardProfileSignInProgressChanged(
  progress: HiveWardCloudSignInProgress | null
): void {
  broadcast(HIVEWARD_PROFILE_SIGN_IN_PROGRESS_CHANGED_CHANNEL, progress)
}
