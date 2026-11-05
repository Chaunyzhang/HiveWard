import { getAppEnvironment } from '../../shared/app-environment'
import {
  getHiveWardProfileDataFile as getSharedHiveWardProfileDataFile,
  getHiveWardProfileStateDatabaseFile as getSharedHiveWardProfileStateDatabaseFile
} from '../../shared/profile-state-storage-paths'
import { hasProfileStateDatabaseFiles } from '../persistence/profile-state/profile-state-storage-classification'
import { join } from 'node:path'

const LEGACY_DATA_FILE_NAME = 'hiveward-data.json'
const LEGACY_BROWSER_SESSION_META_FILE_NAME = 'browser-session-meta.json'
const PROFILE_INDEX_FILE_NAME = 'hiveward-profile-index.json'
const PROFILE_BROWSER_SESSION_META_FILE_NAME = 'browser-session-meta.json'
const PROFILE_DIRECTORY_NAME = 'profiles'
const PROFILE_MOVE_INTENT_DIRECTORY_NAME = 'profile-move-intents'

export const LEGACY_BACKUP_COUNT = 5

let profileUserDataPath: string | null = null

export function initHiveWardProfilePaths(): void {
  profileUserDataPath = getAppEnvironment().getPath('userData')
}

export function getProfileUserDataPath(): string {
  if (!profileUserDataPath) {
    profileUserDataPath = getAppEnvironment().getPath('userData')
  }
  return profileUserDataPath
}

export function getHiveWardProfileIndexPath(userDataPath = getProfileUserDataPath()): string {
  return join(userDataPath, PROFILE_INDEX_FILE_NAME)
}

export function getHiveWardProfilesDirectory(userDataPath = getProfileUserDataPath()): string {
  return join(userDataPath, PROFILE_DIRECTORY_NAME)
}

/** Durable cross-profile move intents live outside either profile database. */
export function getHiveWardProfileMoveIntentDirectory(userDataPath = getProfileUserDataPath()): string {
  return join(userDataPath, PROFILE_MOVE_INTENT_DIRECTORY_NAME)
}

export function getHiveWardProfileDirectory(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return join(getHiveWardProfilesDirectory(userDataPath), profileId)
}

export function getHiveWardProfileDataFile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return getSharedHiveWardProfileDataFile(profileId, userDataPath)
}

export function getHiveWardProfileStateDatabaseFile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return getSharedHiveWardProfileStateDatabaseFile(profileId, userDataPath)
}

export function hasHiveWardProfileStateDatabase(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): boolean {
  const databaseFile = getHiveWardProfileStateDatabaseFile(profileId, userDataPath)
  return hasProfileStateDatabaseFiles(databaseFile)
}

export function getHiveWardProfileBrowserSessionMetaFile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return join(
    getHiveWardProfileDirectory(profileId, userDataPath),
    PROFILE_BROWSER_SESSION_META_FILE_NAME
  )
}

export function legacyDataFilePath(userDataPath: string): string {
  return join(userDataPath, LEGACY_DATA_FILE_NAME)
}

export function legacyBrowserSessionMetaPath(userDataPath: string): string {
  return join(userDataPath, LEGACY_BROWSER_SESSION_META_FILE_NAME)
}

export function legacyBackupPath(userDataPath: string, index: number): string {
  return `${legacyDataFilePath(userDataPath)}.bak.${index}`
}

export function profileBackupPath(profileDataFile: string, index: number): string {
  return `${profileDataFile}.bak.${index}`
}
