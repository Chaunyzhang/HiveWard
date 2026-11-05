import { createProfileStateStoreForStartup } from '../persistence/profile-state/profile-state-startup-authority'
import type { ProfileStateStoreFactoryResult } from '../persistence/profile-state/profile-state-store-factory'
import { ensureActiveHiveWardProfile, initHiveWardProfilePaths } from '../hiveward-profiles/profile-index-store'
import { initSshHostKeyStoreFile } from '../ssh/ssh-host-key-store'
import { initHivewarddHeldFenceTokenFile } from '../ssh/hivewardd-held-fence-tokens'
import { emitHivewarddProfileStateAuthoritySelected } from './hivewardd-profile-state-telemetry'
import { isWslHostHivewarddProcess } from '../ipc/wsl-guest-windows-drive-path'

/** WSL hosts are held to a per-distro memory budget; the idle writer thread costs ~13-15 MB. */
export const WSL_HOST_PROFILE_WRITER_IDLE_STOP_MS = 60_000

/** SSH hosts and the desktop keep their writer thread running. */
export function hivewarddProfileWriterIdleStopMs(
  isWslHost: () => boolean = isWslHostHivewarddProcess
): number | undefined {
  return isWslHost() ? WSL_HOST_PROFILE_WRITER_IDLE_STOP_MS : undefined
}

type HivewarddProfileStateStartup = {
  store: ProfileStateStoreFactoryResult['store']
  authority: {
    backend: ProfileStateStoreFactoryResult['backend']
    classification: ProfileStateStoreFactoryResult['classification']
    authority_mode: 'sqlite-established'
    runtime: 'hivewardd'
    migrated: boolean
  }
}

export async function createHivewarddProfileStateStartup(
  userDataPath: string
): Promise<HivewarddProfileStateStartup> {
  initHiveWardProfilePaths()
  const profile = ensureActiveHiveWardProfile(userDataPath)
  // Real persistence avoids falsely empty RPCs; headless authority keeps automations owned by this host.
  const result = await createProfileStateStoreForStartup({
    userDataPath,
    dataFile: profile.dataFile,
    databaseFile: profile.stateDatabaseFile,
    profileId: profile.profile.id,
    runtime: 'hivewardd',
    storageAuthority: 'runtime',
    writerIdleStopMs: hivewarddProfileWriterIdleStopMs()
  })
  const authority = {
    backend: result.backend,
    classification: result.classification,
    authority_mode: 'sqlite-established' as const,
    runtime: 'hivewardd' as const,
    migrated: result.migrated
  }
  try {
    initSshHostKeyStoreFile(profile.dataFile)
    initHivewarddHeldFenceTokenFile(profile.dataFile)
    emitHivewarddProfileStateAuthoritySelected(authority)
    return { store: result.store, authority }
  } catch (error) {
    try {
      await result.store.freezeWritesAsync()
    } catch (closeError) {
      console.error(
        '[persistence] Failed to close profile persistence after startup failure:',
        closeError
      )
    }
    throw error
  }
}
