import {
  compatibleHiveWardPath,
  resolveHiveWardProfileOverride
} from '../../shared/hiveward-profile-paths'
import { hivewardEnvironment } from '../../shared/hiveward-environment.mjs'
import { hivewardProduct } from '../../shared/hiveward-policy'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  findTransport,
  getRuntimeMetadataPath,
  type RuntimeMetadata
} from '../../shared/runtime-bootstrap'
import { RuntimeClientError } from './types'

export function readMetadata(userDataPath: string): RuntimeMetadata {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadata | null
    if (!metadata || !findTransport(metadata, 'unix', 'named-pipe') || !metadata.authToken) {
      throw new RuntimeClientError(
        'runtime_unavailable',
        `HiveWard runtime metadata is incomplete at ${metadataPath}`
      )
    }
    return metadata
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      throw error
    }
    throw new RuntimeClientError(
      'runtime_unavailable',
      `Could not read HiveWard runtime metadata at ${metadataPath}. Start the HiveWard app first.`
    )
  }
}

export function tryReadMetadata(userDataPath: string): RuntimeMetadata | null {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  try {
    return JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadata | null
  } catch {
    return null
  }
}

export function getDefaultUserDataPath(
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir()
): string {
  // 显式资料路径优先，防止子进程被父终端的默认实例定位覆盖。
  if (process.env.HIVEWARD_USER_DATA_PATH) {
    return resolveHiveWardProfileOverride(process.env.HIVEWARD_USER_DATA_PATH)
  }
  if (hivewardEnvironment.HIVEWARD_USER_DATA_PATH) {
    return resolveHiveWardProfileOverride(hivewardEnvironment.HIVEWARD_USER_DATA_PATH)
  }
  return getPlatformUserDataPath(platform, homeDir)
}

/** The packaged app's own default profile, ignoring any CLI override. */
export function getPlatformUserDataPath(
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir()
): string {
  if (platform === 'darwin') {
    return compatibleHiveWardPath(
      join(homeDir, 'Library', 'Application Support', hivewardProduct.dataDirectory),
      join(homeDir, 'Library', 'Application Support', 'OPC-Engine')
    )
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) {
      throw new RuntimeClientError(
        'runtime_unavailable',
        'APPDATA is not set, so the HiveWard runtime metadata path cannot be resolved.'
      )
    }
    return compatibleHiveWardPath(
      join(appData, hivewardProduct.dataDirectory),
      join(appData, 'OPC-Engine')
    )
  }
  // Match Electron’s packaged userData path.
  const base = process.env.XDG_CONFIG_HOME || join(homeDir, '.config')
  return compatibleHiveWardPath(join(base, hivewardProduct.dataDirectory), join(base, 'OPC-Engine'))
}
