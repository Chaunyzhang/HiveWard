import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function dataDir() {
  return process.env.OPC_DATA_DIR
    ? resolve(process.env.OPC_DATA_DIR)
    : join(homedir(), 'Library/Application Support/OPC-Engine/opc-data')
}
