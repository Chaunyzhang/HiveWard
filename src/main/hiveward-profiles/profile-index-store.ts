import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { bestEffortFsyncDirectorySync, fsyncFileSync } from '../../shared/secure-file'
import {
  createDefaultLocalHiveWardProfile,
  DEFAULT_LOCAL_HIVEWARD_PROFILE_ID,
  DEFAULT_LOCAL_HIVEWARD_PROFILE_NAME,
  HIVEWARD_PROFILE_INDEX_SCHEMA_VERSION,
  type CreateLocalHiveWardProfileArgs,
  type CreateLocalHiveWardProfileResult,
  type HiveWardProfileIndex,
  type HiveWardProfileListState,
  type HiveWardProfileSummary
} from '../../shared/hiveward-profiles'
import {
  getHiveWardProfileDataFile,
  getHiveWardProfileDirectory,
  getHiveWardProfileIndexPath,
  getHiveWardProfileStateDatabaseFile,
  hasHiveWardProfileStateDatabase,
  getProfileUserDataPath
} from './profile-storage-paths'
import { copyLegacyStateToProfile } from './profile-legacy-state-import'
import { profileStateJsonExportPaths } from '../persistence/profile-state/legacy-json/profile-state-export-path'
import { hasProfileStateAuthorityMarker } from '../persistence/profile-state/profile-state-authority-marker'
import { profileStateDatabaseBackups } from '../persistence/profile-state/profile-state-backup-path'

export {
  getHiveWardProfileBrowserSessionMetaFile,
  getHiveWardProfileDataFile,
  getHiveWardProfileDirectory,
  getHiveWardProfileIndexPath,
  getHiveWardProfileStateDatabaseFile,
  hasHiveWardProfileStateDatabase,
  getHiveWardProfilesDirectory,
  initHiveWardProfilePaths
} from './profile-storage-paths'

export type ActiveHiveWardProfileState = {
  index: HiveWardProfileIndex
  profile: HiveWardProfileSummary
  dataFile: string
  stateDatabaseFile: string
  profileDirectory: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProfileSummary(value: unknown): value is HiveWardProfileSummary {
  if (!isObject(value)) {
    return false
  }
  const avatar = value.avatar
  const cloud = value.cloud
  return (
    typeof value.id === 'string' &&
    // Index IDs become path segments; reject traversal outside the profile directory.
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.id) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    (value.kind === 'local' || value.kind === 'cloud-linked') &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.lastOpenedAt === 'number' &&
    isObject(avatar) &&
    avatar.kind === 'initials' &&
    typeof avatar.initials === 'string' &&
    avatar.color === 'neutral' &&
    (cloud === undefined || isObject(cloud))
  )
}

function normalizeProfileIndex(raw: unknown): HiveWardProfileIndex | null {
  if (!isObject(raw) || !Array.isArray(raw.profiles)) {
    return null
  }
  const profiles = raw.profiles.filter(isProfileSummary)
  const activeProfileId =
    typeof raw.activeProfileId === 'string' &&
    profiles.some((profile) => profile.id === raw.activeProfileId)
      ? raw.activeProfileId
      : profiles[0]?.id
  if (!activeProfileId) {
    return null
  }
  return {
    schemaVersion: HIVEWARD_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId,
    profiles
  }
}

function sanitizeProfileName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed.slice(0, 80) : 'New Profile'
}

function readProfileIndexFile(indexPath: string): HiveWardProfileIndex | null {
  try {
    return normalizeProfileIndex(JSON.parse(readFileSync(indexPath, 'utf-8')))
  } catch {
    return null
  }
}

export function readProfileIndex(indexPath: string): HiveWardProfileIndex | null {
  // Recover from backup rather than orphan other profiles by resetting a corrupt index.
  return readProfileIndexFile(indexPath) ?? readProfileIndexFile(`${indexPath}.bak`)
}

function readExistingProfileIndex(indexPath: string): HiveWardProfileIndex | null {
  const index = readProfileIndex(indexPath)
  if (!index && (existsSync(indexPath) || existsSync(`${indexPath}.bak`))) {
    throw new Error(`Could not read active profile index ${indexPath}`)
  }
  return index
}

export function writeProfileIndex(indexPath: string, index: HiveWardProfileIndex): void {
  mkdirSync(dirname(indexPath), { recursive: true })
  // Never replace the recovery backup with a corrupt primary index.
  if (existsSync(indexPath) && readProfileIndexFile(indexPath)) {
    try {
      copyFileSync(indexPath, `${indexPath}.bak`)
    } catch {
      // Backup failure must not block the primary write.
    }
  }
  const tmpPath = `${indexPath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf-8')
  fsyncFileSync(tmpPath)
  renameSync(tmpPath, indexPath)
  bestEffortFsyncDirectorySync(dirname(indexPath))
}

function createInitialProfileIndex(now = Date.now()): HiveWardProfileIndex {
  const profile = createDefaultLocalHiveWardProfile(now)
  return {
    schemaVersion: HIVEWARD_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId: profile.id,
    profiles: [profile]
  }
}

export function loadOrCreateProfileIndex(userDataPath: string): HiveWardProfileIndex {
  const indexPath = getHiveWardProfileIndexPath(userDataPath)
  const index = readExistingProfileIndex(indexPath)
  if (index) {
    return index
  }
  const nextIndex = createInitialProfileIndex()
  writeProfileIndex(indexPath, nextIndex)
  return nextIndex
}

function getActiveProfile(index: HiveWardProfileIndex): HiveWardProfileSummary {
  return (
    index.profiles.find((profile) => profile.id === index.activeProfileId) ??
    index.profiles[0] ??
    createDefaultLocalHiveWardProfile(Date.now())
  )
}

export function ensureActiveHiveWardProfile(
  userDataPath = getProfileUserDataPath()
): ActiveHiveWardProfileState {
  const indexPath = getHiveWardProfileIndexPath(userDataPath)
  let index = readExistingProfileIndex(indexPath)
  let shouldWriteIndex = !existsSync(indexPath)

  if (!index) {
    index = createInitialProfileIndex()
    shouldWriteIndex = true
  }

  const activeProfile = getActiveProfile(index)
  if (activeProfile.id !== index.activeProfileId) {
    index = { ...index, activeProfileId: activeProfile.id }
    shouldWriteIndex = true
  }

  const profileDirectory = getHiveWardProfileDirectory(activeProfile.id, userDataPath)
  mkdirSync(profileDirectory, { recursive: true })
  const profileDatabaseFile = getHiveWardProfileStateDatabaseFile(activeProfile.id, userDataPath)
  const profileDataFile = getHiveWardProfileDataFile(activeProfile.id, userDataPath)
  let hasRetainedProfileStateAuthority = false
  try {
    hasRetainedProfileStateAuthority =
      hasProfileStateAuthorityMarker(profileDatabaseFile) ||
      profileStateJsonExportPaths(profileDataFile).length > 0 ||
      profileStateDatabaseBackups(profileDatabaseFile).length > 0
  } catch {
    // An unreadable profile directory must never trigger a fallback copy of legacy state.
    hasRetainedProfileStateAuthority = true
  }
  if (
    activeProfile.id === DEFAULT_LOCAL_HIVEWARD_PROFILE_ID &&
    !hasHiveWardProfileStateDatabase(activeProfile.id, userDataPath) &&
    !hasRetainedProfileStateAuthority
  ) {
    copyLegacyStateToProfile(userDataPath, activeProfile.id)
  }

  if (shouldWriteIndex) {
    writeProfileIndex(indexPath, index)
  }

  return {
    index,
    profile: activeProfile,
    dataFile: profileDataFile,
    stateDatabaseFile: profileDatabaseFile,
    profileDirectory
  }
}

export function isDefaultLocalHiveWardProfileId(profileId: string): boolean {
  return profileId === DEFAULT_LOCAL_HIVEWARD_PROFILE_ID
}

export function getHiveWardProfileListState(
  userDataPath = getProfileUserDataPath()
): HiveWardProfileListState {
  const { index } = ensureActiveHiveWardProfile(userDataPath)
  return {
    activeProfileId: index.activeProfileId,
    profiles: index.profiles
  }
}

export function createLocalHiveWardProfile(
  args: CreateLocalHiveWardProfileArgs = {},
  userDataPath = getProfileUserDataPath()
): CreateLocalHiveWardProfileResult {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  const name = sanitizeProfileName(args.name)
  const profile: HiveWardProfileSummary = {
    id: `local-${randomUUID()}`,
    name,
    avatar: {
      kind: 'initials',
      initials: (
        name.match(/[A-Za-z0-9]/)?.[0] ?? DEFAULT_LOCAL_HIVEWARD_PROFILE_NAME[0]
      ).toUpperCase(),
      color: 'neutral'
    },
    kind: 'local',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  }
  const nextIndex: HiveWardProfileIndex = {
    ...index,
    profiles: [...index.profiles, profile]
  }
  mkdirSync(getHiveWardProfileDirectory(profile.id, userDataPath), { recursive: true })
  writeProfileIndex(getHiveWardProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles,
    profile
  }
}

export function setActiveHiveWardProfile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): HiveWardProfileListState {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  let found = false
  const profiles = index.profiles.map((profile) => {
    if (profile.id !== profileId) {
      return profile
    }
    found = true
    return {
      ...profile,
      updatedAt: now,
      lastOpenedAt: now
    }
  })
  if (!found) {
    throw new Error('unknown_hiveward_profile')
  }
  const nextIndex: HiveWardProfileIndex = {
    ...index,
    activeProfileId: profileId,
    profiles
  }
  mkdirSync(getHiveWardProfileDirectory(profileId, userDataPath), { recursive: true })
  writeProfileIndex(getHiveWardProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles
  }
}
