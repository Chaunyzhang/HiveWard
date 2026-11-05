import { browserSessionRegistry } from './browser-session-registry'
import type { BrowserSessionRegistryProfileOptions } from './browser-session-registry'
import { collectOrphanedBrowserRoutePartitionStorage } from './browser-route-partition-storage-runtime'
import { configureRouteSessionsForHiveWardProfile } from './browser-route-session-runtime'
import { configureBrowserSitePermissionStore } from './browser-site-permission-store'
import { configureBrowserSiteDisplayStore } from './browser-site-display-store'
import { configureBrowserExtensionProfileDataDirectory } from './extensions/browser-extension-profile-data-directory'
import { configurePairedRuntimeBrowserClientHostsForHiveWardProfile } from './paired-runtime-browser-client-host-runtime'

let initialized = false

export function initializeBrowserSessionsForApp(
  activeProfile?: BrowserSessionRegistryProfileOptions & {
    listLocalSshTargetIds?: () => string[]
  }
): void {
  if (initialized) {
    return
  }

  if (activeProfile) {
    browserSessionRegistry.configureForHiveWardProfile(activeProfile)
    configureBrowserSitePermissionStore(activeProfile.profileDirectory)
    configureBrowserSiteDisplayStore(activeProfile.profileDirectory)
    configureBrowserExtensionProfileDataDirectory(activeProfile.profileDirectory)
    configureRouteSessionsForHiveWardProfile({
      hivewardProfileId: activeProfile.hivewardProfileId,
      profileDirectory: activeProfile.profileDirectory
    })
    configurePairedRuntimeBrowserClientHostsForHiveWardProfile({
      hivewardProfileId: activeProfile.hivewardProfileId
    })
    void collectOrphanedBrowserRoutePartitionStorage(activeProfile.listLocalSshTargetIds).catch(
      (error) => {
        console.warn('[browser-route-partition] orphan collection failed:', error)
      }
    )
  }

  // Replay cookies before Chromium opens the live DB via session.fromPartition.
  browserSessionRegistry.applyPendingCookieImport()
  browserSessionRegistry.initializeBrowserSessionsFromPersistedState()
  initialized = true
}

/** Whether a partition may be opened: before this, opening one would skip a pending cookie import. */
export function browserSessionsInitialized(): boolean {
  return initialized
}
