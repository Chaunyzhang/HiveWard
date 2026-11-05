// In-place WSL moves require the desktop-launched hivewardd in the source distro to own the unchanged paths.
import type { HivewarddMigrationManifestSource } from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import { isHivewarddMigrationLocalWslSource } from '../../shared/hivewardd-migration/hivewardd-migration-source-kind'
import { isWslHostHivewarddProcess } from '../ipc/wsl-guest-windows-drive-path'
import { HIVEWARDD_WSL_DISTRO_GUID_ENV } from '../../shared/hivewardd-server-launch-env'

export const HIVEWARDD_MIGRATION_SOURCE_NOT_THIS_HOST = 'hivewardd_migration_source_not_this_host'

export { HIVEWARDD_WSL_DISTRO_GUID_ENV }

export function servesLocalWslMigrationSource(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return isWslHostHivewarddProcess(env, platform)
}

// E2E hosts stand in for a WSL host's hivewardd; a real one is identified by isWslHostHivewarddProcess.
export const HIVEWARD_E2E_WSL_MOVE_DESTINATION_ENV = 'HIVEWARD_E2E_WSL_MOVE_DESTINATION'

/**
 * Whether this host is a WSL move's destination: it installs moved panes' terminal history and
 * serves their stored scrollback. Every other host keeps that wire surface off.
 */
export function servesWslMovedPaneHistory(env: NodeJS.ProcessEnv = process.env): boolean {
  return isWslHostHivewarddProcess(env) || env[HIVEWARD_E2E_WSL_MOVE_DESTINATION_ENV] === '1'
}

export function assertHivewarddMigrationSourceServedHere(
  source: HivewarddMigrationManifestSource,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): void {
  if (!isHivewarddMigrationLocalWslSource(source)) {
    return
  }
  // WSL distro names and their UNC forms are case-insensitive.
  const distro = env.WSL_DISTRO_NAME?.trim().toLowerCase()
  if (!servesLocalWslMigrationSource(env, platform) || distro !== source.distro.toLowerCase()) {
    throw new Error(HIVEWARDD_MIGRATION_SOURCE_NOT_THIS_HOST)
  }
  // Re-registering a distro reuses its name, not its files; require its registry ID when supplied.
  const guid = env[HIVEWARDD_WSL_DISTRO_GUID_ENV]?.trim().toLowerCase()
  if (source.distroGuid !== undefined && guid !== source.distroGuid.toLowerCase()) {
    throw new Error(HIVEWARDD_MIGRATION_SOURCE_NOT_THIS_HOST)
  }
}
