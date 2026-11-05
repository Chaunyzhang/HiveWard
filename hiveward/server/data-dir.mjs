import { compatibleProfilePath, compatibleDataDirectory } from '../shared/profile-paths.mjs'
import { hivewardEnvironment } from '../shared/environment.mjs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function dataDir() {
  if (hivewardEnvironment.HIVEWARD_DATA_DIR) {return resolve(hivewardEnvironment.HIVEWARD_DATA_DIR)}
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const root = compatibleProfilePath(join(base, 'HiveWard'), join(base, 'OPC-Engine'))
  return compatibleDataDirectory(root)
}
