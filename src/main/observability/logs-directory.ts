import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

// Use the environment port for plain Node hosts. Keep userData/logs on macOS
// because Electron’s logs path would strand existing bundles.
function getUserDataDir(): string {
  if (hasAppEnvironment()) {
    return getAppEnvironment().getPath('userData')
  }
  const home = homedir()
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'HiveWard')
  }
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? home, 'HiveWard')
  }
  return join(home, '.config', 'HiveWard')
}

export function getLogsDirectory(): string {
  return join(getUserDataDir(), 'logs')
}

export function getTraceFilePath(): string {
  return join(getLogsDirectory(), 'main.trace.ndjson')
}

export function getHivewarddTraceFilePath(): string {
  return join(getLogsDirectory(), 'hivewardd.trace.ndjson')
}

export function getDaemonLogFilePath(): string {
  return join(getLogsDirectory(), 'daemon.log')
}
