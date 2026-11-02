import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function dataDir() {
  return process.env.OPC_DATA_DIR
    ? resolve(process.env.OPC_DATA_DIR)
    : join(
        process.platform === 'win32'
          ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
          : process.platform === 'darwin'
            ? join(homedir(), 'Library', 'Application Support')
            : process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
        'OPC-Engine',
        'opc-data'
      )
}
