import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export function compatibleProfilePath(current, legacy) {
  if (existsSync(current)) {
    try {
      const marker = JSON.parse(readFileSync(join(current, '.hiveward-migration.json'), 'utf8'))
      if (marker.phase === 'complete') {return current}
    } catch {}
    if (!existsSync(legacy)) {return current}
  }
  return existsSync(legacy) ? legacy : current
}

export function compatibleRuntimeMetadata(root) {
  const current = join(root, 'hiveward-runtime.json')
  const legacy = join(root, 'opc-runtime.json')
  return !existsSync(current) && existsSync(legacy) ? legacy : current
}

export function compatibleDataDirectory(root) {
  const current = join(root, 'hiveward-data')
  const legacy = join(root, 'opc-data')
  return !existsSync(current) && existsSync(legacy) ? legacy : current
}

export function compatibleBrowserPartition(root, profile) {
  const suffix = profile.replace(/[^\w-]/g, '_')
  const current = `hiveward-${suffix}`
  const legacy = `opc-${suffix}`
  return `persist:${!existsSync(join(root, 'Partitions', current)) && existsSync(join(root, 'Partitions', legacy)) ? legacy : current}`
}

export function hivewardHomePath(home = homedir()) {
  return compatibleProfilePath(join(home, '.hiveward'), join(home, '.opc-engine'))
}

export function resolveHiveWardProfileOverride(value) {
  const path = resolve(value)
  try {
    const marker = JSON.parse(readFileSync(join(path, '.hiveward-migration.json'), 'utf8'))
    if (marker.phase === 'complete' && marker.source === path && typeof marker.target === 'string')
      {return marker.target}
  } catch {}
  return path
}
