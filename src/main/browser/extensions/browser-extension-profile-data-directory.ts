import { app } from 'electron'
import { join } from 'node:path'

let hivewardProfileDirectory: string | null = null

/** Browser profile ids repeat across HiveWard profiles ("default"), so their extension data lives per HiveWard profile. */
export function configureBrowserExtensionProfileDataDirectory(profileDirectory: string): void {
  hivewardProfileDirectory = profileDirectory
}

/** Root of the per-browser-profile extension stores (sync storage, grants and state, DNR). */
export function getBrowserExtensionProfileDataDirectory(): string {
  return join(hivewardProfileDirectory ?? app.getPath('userData'), 'browser-extensions')
}
