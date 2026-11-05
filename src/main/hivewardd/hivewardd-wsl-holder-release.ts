/**
 * Lets a WSL distro stop once its hivewardd idle-stops with nothing left to keep (R40). The desktop's
 * holder keeps the distro up; it reads this request and ends after hivewardd's pid exits.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { HIVEWARDD_WSL_HOLDER_RELEASE_FILENAME } from '../../shared/hivewardd-idle-exit'
import { writeSecureFile } from '../../shared/secure-file'
import { HIVEWARDD_WSL_HOST_ENV } from '../ipc/wsl-guest-windows-drive-path'
import type { HivewarddDaemonRetirement } from './hivewardd-daemon-retirement'

export function hivewarddWslHolderReleasePath(userDataPath: string): string {
  return join(userDataPath, HIVEWARDD_WSL_HOLDER_RELEASE_FILENAME)
}

/**
 * Only a WSL-host launch has a holder, and only a daemon that proved itself empty and left shows
 * no terminal would die with the distro. Why the launch marker: a setsid'd hivewardd may lack WSL_DISTRO_NAME.
 */
export function idleStopMayReleaseWslHolder(
  env: NodeJS.ProcessEnv,
  daemon: HivewarddDaemonRetirement
): boolean {
  return env[HIVEWARDD_WSL_HOST_ENV] === '1' && daemon.retirement === 'retired'
}

export function requestHivewarddWslHolderRelease(userDataPath: string, pid = process.pid): void {
  writeSecureFile(hivewarddWslHolderReleasePath(userDataPath), `${pid}\n`)
}

/**
 * A starting hivewardd may be given work, so any earlier request no longer stands. WSL-host launches
 * only; never throws, so a locked or unwritable data root cannot fail a start or a stop.
 */
export function withdrawHivewarddWslHolderRelease(
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env[HIVEWARDD_WSL_HOST_ENV] !== '1') {
    return
  }
  try {
    rmSync(hivewarddWslHolderReleasePath(userDataPath), { force: true })
  } catch (error) {
    console.error('[hivewardd] could not withdraw the WSL holder release request:', error)
  }
}
