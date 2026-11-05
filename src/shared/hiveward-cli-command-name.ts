import { getAppEnvironment, hasAppEnvironment } from './app-environment'

export function getHiveWardCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'hiveward'
  }
  if (platform === 'win32') {
    return 'hiveward.cmd'
  }
  return 'hiveward'
}

/** The GNOME-conflict `hiveward-ide` rename is desktop-only: SSH relays and headless HiveWard servers put plain `hiveward` on PATH. */
export function skipsLinuxHiveWardCliRename(isRemote: boolean | undefined): boolean {
  if (isRemote) {
    return true
  }
  // Only a headless server publishes its own launcher; Windows ones (WSL launches) keep the rename.
  const launcher = hasAppEnvironment() ? getAppEnvironment().getCliLauncherPath?.() : null
  return launcher?.endsWith('/hiveward') ?? false
}
