import { chmodSync, statSync } from 'node:fs'
import process from 'node:process'
import { restrictWindowsPathSync } from '../../shared/secure-path-windows-acl'

type HivewarddInstanceLockCode =
  | 'hivewardd_data_root_unusable'
  | 'hivewardd_data_root_wrong_owner'
  | 'hivewardd_data_root_shared'
  | 'hivewardd_instance_lock_held'
  /** Shared-home/foreign-machine owners may still run and cannot be judged here. */
  | 'hivewardd_instance_lock_holder_unverifiable'
  | 'hivewardd_instance_lock_foreign_identity'
  | 'hivewardd_instance_lock_unreadable'

export class HivewarddInstanceLockError extends Error {
  constructor(
    readonly code: HivewarddInstanceLockCode,
    message: string
  ) {
    super(message)
    this.name = 'HivewarddInstanceLockError'
  }
}

export type HivewarddDataRootPrivacyHooks = {
  platform?: NodeJS.Platform
  restrictWindowsDataRoot?: (dataRoot: string) => boolean
}

/** Repair owned directory permissions before refusing: roots contain credentials and session state. */
export function assertHivewarddDataRootIsPrivate(
  dataRoot: string,
  hooks: HivewarddDataRootPrivacyHooks
): void {
  // Windows synthesizes POSIX mode bits; restrict and verify real ACLs instead.
  if ((hooks.platform ?? process.platform) === 'win32') {
    const restrict =
      hooks.restrictWindowsDataRoot ?? ((path: string) => restrictWindowsPathSync(path, true))
    if (!restrict(dataRoot)) {
      throw new HivewarddInstanceLockError(
        'hivewardd_data_root_shared',
        `Could not restrict the hivewardd data root ${dataRoot} to this user. hivewardd keeps ` +
          'private session and credential state there, so it refuses to start. Point HIVEWARD_USER_DATA at a ' +
          'directory this account owns.'
      )
    }
    return
  }
  let stats
  try {
    stats = statSync(dataRoot)
  } catch (error) {
    throw new HivewarddInstanceLockError(
      'hivewardd_data_root_unusable',
      `Cannot stat the hivewardd data root ${dataRoot}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) {
    throw new HivewarddInstanceLockError(
      'hivewardd_data_root_wrong_owner',
      `The hivewardd data root ${dataRoot} is owned by uid ${stats.uid}, not by uid ${uid} running ` +
        'this process. Give hivewardd its own data root (HIVEWARD_USER_DATA) or chown this one.'
    )
  }
  if ((stats.mode & 0o077) === 0) {
    return
  }
  try {
    chmodSync(dataRoot, 0o700)
  } catch {
    // Re-stat to produce the actionable permission error.
  }
  let mode: number
  try {
    mode = statSync(dataRoot).mode
  } catch (error) {
    throw new HivewarddInstanceLockError(
      'hivewardd_data_root_unusable',
      `Cannot stat the hivewardd data root ${dataRoot}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if ((mode & 0o077) !== 0) {
    throw new HivewarddInstanceLockError(
      'hivewardd_data_root_shared',
      `The hivewardd data root ${dataRoot} is accessible to other users (mode ` +
        `${(mode & 0o777).toString(8)}) and could not be tightened. hivewardd keeps ` +
        'private session and credential state there, so it refuses to start. Run `chmod 700` on it, or point HIVEWARD_USER_DATA ' +
        'at a private directory.'
    )
  }
}
