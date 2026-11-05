import { join } from 'node:path'

// Why `hiveward` on Linux: GNOME HiveWard ships /usr/bin/hiveward, so the CLI never claims that name.
export const LINUX_CLI_COMMAND_NAME = 'hiveward'

/** The public `hiveward` command (alias of `hiwd`) that HiveWard puts on PATH; it forwards engine commands. */
// Keep path-only callers independent of cli-installer's Electron dependency.
export function getBundledLauncherPath(
  platform: NodeJS.Platform,
  resourcesPath: string
): string | null {
  if (platform === 'darwin') {
    return join(resourcesPath, 'bin', 'hiveward')
  }
  if (platform === 'linux') {
    return join(resourcesPath, 'bin', LINUX_CLI_COMMAND_NAME)
  }
  if (platform === 'win32') {
    return join(resourcesPath, 'bin', 'hiveward.cmd')
  }
  return null
}

/** The internal engine launcher (kept off PATH); Windows needs its native exe because cmd.exe mangles `%*`. */
export function getBundledEngineLauncherPath(
  platform: NodeJS.Platform,
  resourcesPath: string
): string | null {
  if (platform === 'darwin' || platform === 'linux') {
    return join(resourcesPath, 'engine', 'hiwd-engine')
  }
  if (platform === 'win32') {
    return join(resourcesPath, 'engine', 'hiwd-engine.exe')
  }
  return null
}
