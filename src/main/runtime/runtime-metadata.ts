import { existsSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getRuntimeMetadataPath,
  LEGACY_RUNTIME_METADATA_FILE,
  PRIMARY_RUNTIME_METADATA_FILE,
  type RuntimeMetadata
} from '../../shared/runtime-bootstrap'
import { writeSecureJsonFile } from '../../shared/secure-file'

export function writeRuntimeMetadata(userDataPath: string, metadata: RuntimeMetadata): void {
  writeMetadataFile(join(userDataPath, PRIMARY_RUNTIME_METADATA_FILE), metadata)
}

export function readRuntimeMetadata(userDataPath: string): RuntimeMetadata | null {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  if (!existsSync(metadataPath)) {
    return null
  }
  return JSON.parse(readFileSync(metadataPath, 'utf-8')) as RuntimeMetadata
}

/** Off-thread twin of {@link readRuntimeMetadata} for pollers; a missing file is not an error. */
export async function readRuntimeMetadataAsync(
  userDataPath: string
): Promise<RuntimeMetadata | null> {
  const read = (path: string) => readFile(path, 'utf-8')
  let raw: string
  try {
    raw = await read(join(userDataPath, PRIMARY_RUNTIME_METADATA_FILE))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
    try {
      raw = await read(join(userDataPath, LEGACY_RUNTIME_METADATA_FILE))
    } catch (legacyError) {
      if (legacyError instanceof Error && 'code' in legacyError && legacyError.code === 'ENOENT') {
        return null
      }
      throw legacyError
    }
  }
  const parsed: RuntimeMetadata = JSON.parse(raw)
  return parsed
}

export function clearRuntimeMetadata(userDataPath: string): void {
  rmSync(getRuntimeMetadataPath(userDataPath), { force: true })
}

/** Clear only matching startup pid/runtimeId so old-process teardown cannot erase updater handoff metadata.
 * Capture both synchronously before shutdown awaits; teardown globals may already describe a replacement. */
export function clearRuntimeMetadataIfOwned(
  userDataPath: string,
  ownedPid: number,
  ownedRuntimeId: string
): void {
  const current = readRuntimeMetadata(userDataPath)
  if (!current) {
    return
  }
  if (current.pid !== ownedPid) {
    return
  }
  if (current.runtimeId !== ownedRuntimeId) {
    return
  }
  clearRuntimeMetadata(userDataPath)
}

function writeMetadataFile(path: string, metadata: RuntimeMetadata): void {
  writeSecureJsonFile(path, metadata)
}
