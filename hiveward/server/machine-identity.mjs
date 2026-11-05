import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './data-dir.mjs'

export function localMachine() {
  try {
    const machine = JSON.parse(readFileSync(join(dataDir(), 'machine.json'), 'utf8'))
    return typeof machine.id === 'string' && machine.id ? machine : undefined
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

export function localMachineId() {
  return localMachine()?.id
}

export function remoteOrigin(dispatch) {
  const machineId = dispatch.by?.machineId
  return !!machineId && machineId !== localMachineId()
}
