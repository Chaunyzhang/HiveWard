import { HIVEWARD_BROWSER_PARTITION } from './constants'
import type { ExecutionHostId } from './execution-host'

export const HIVEWARD_PROFILE_INDEX_SCHEMA_VERSION = 1
export const DEFAULT_LOCAL_HIVEWARD_PROFILE_ID = 'local-default'
export const DEFAULT_LOCAL_HIVEWARD_PROFILE_NAME = 'Personal'
/** Main -> renderer push when the stored auth status changed without the renderer asking. */
export const HIVEWARD_PROFILE_AUTH_STATUS_CHANGED_CHANNEL = 'hivewardProfiles:authStatusChanged'
export const HIVEWARD_PROFILE_SIGN_IN_PROGRESS_CHANGED_CHANNEL = 'hivewardProfiles:signInProgressChanged'
const LEGACY_HIVEWARD_BROWSER_SESSION_PARTITION_PREFIX = 'persist:hiveward-browser-session-'

export type HiveWardProfileAvatar = {
  kind: 'initials'
  initials: string
  color: 'neutral'
}

export type HiveWardProfileKind = 'local' | 'cloud-linked'

export type HiveWardProfileCloudSummary = {
  cloudProfileId: string
  userId: string
  email: string
  displayName?: string
  activeOrgId?: string
  activeOrgName?: string
  linkedAt: number
}

export type HiveWardCloudOrgSummary = {
  orgId: string
  name: string
  role?: string
}

export type HiveWardCloudCapabilityFlags = Record<string, boolean>

export type HiveWardCloudCapabilities = {
  flags: HiveWardCloudCapabilityFlags
  refreshedAt: number
}

export type HiveWardCloudSessionPersistence = 'none' | 'encrypted' | 'memory-only' | 'dev-plaintext'

export type HiveWardProfileAuthState = 'local' | 'unconfigured' | 'connected' | 'reconnect-required'

export type HiveWardProfileAuthStatus = {
  activeProfileId: string
  configured: boolean
  state: HiveWardProfileAuthState
  persistence: HiveWardCloudSessionPersistence
  cloud?: HiveWardProfileCloudSummary
  organizations?: HiveWardCloudOrgSummary[]
  capabilities?: HiveWardCloudCapabilities
  credentialError?: string
  setupMessage?: string
}

export type HiveWardProfileSummary = {
  id: string
  name: string
  avatar: HiveWardProfileAvatar
  kind: HiveWardProfileKind
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  cloud?: HiveWardProfileCloudSummary
}

export type HiveWardProfileIndex = {
  schemaVersion: number
  activeProfileId: string
  profiles: HiveWardProfileSummary[]
}

export type HiveWardProfileListState = {
  activeProfileId: string
  profiles: HiveWardProfileSummary[]
}

export type HiveWardProfileListResult = HiveWardProfileListState & {
  // Gate the multi-profile switcher; default builds use one-profile account menus.
  multiProfileUi: boolean
}

export type CreateLocalHiveWardProfileArgs = {
  name?: string
}

export type CreateLocalHiveWardProfileResult = HiveWardProfileListState & {
  profile: HiveWardProfileSummary
}

export type CreateCloudLinkedHiveWardProfileArgs = {
  orgId?: string
  name?: string
}

export type SwitchHiveWardProfileArgs = {
  profileId: string
}

export type SwitchHiveWardProfileResult = {
  status: 'already-active' | 'relaunching'
}

export type TransferHiveWardProfileProjectMode = 'move' | 'copy'

export type TransferHiveWardProfileProjectArgs = {
  sourceProfileId: string
  targetProfileId: string
  repoId: string
  mode: TransferHiveWardProfileProjectMode
}

export type FindHiveWardProfileProjectsByPathArgs = {
  path: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  excludeProfileId?: string | null
}

export type HiveWardProfileProjectPresence = {
  profileId: string
  profileName: string
  profileKind: HiveWardProfileKind
  repoId: string
  repoName: string
}

export type FindHiveWardProfileProjectsByPathResult = {
  projects: HiveWardProfileProjectPresence[]
}

export type TransferHiveWardProfileProjectResult =
  | {
      status: 'transferred'
      mode: TransferHiveWardProfileProjectMode
      sourceProfileId: string
      targetProfileId: string
      sourceRepoId: string
      targetRepoId: string
      targetProjectId: string | null
      willRelaunch?: boolean
    }
  | {
      status: 'duplicate-target'
      sourceProfileId: string
      targetProfileId: string
      sourceRepoId: string
      duplicateRepoId: string
    }

/** A sign-in in flight; `link` is set only while the browser has not answered yet. */
export type HiveWardCloudSignInProgress = { link: string | null }

export type ConnectCurrentHiveWardProfileResult =
  | {
      status: 'connected'
      auth: HiveWardProfileAuthStatus
      activeProfileId: string
      profiles: HiveWardProfileSummary[]
    }
  | {
      status: 'unconfigured'
      auth: HiveWardProfileAuthStatus
    }
  | {
      status: 'cancelled'
      auth: HiveWardProfileAuthStatus
    }
  | {
      status: 'timed-out'
      auth: HiveWardProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: HiveWardProfileAuthStatus
      error: string
    }

export type CreateCloudLinkedHiveWardProfileResult =
  | {
      status: 'created'
      auth: HiveWardProfileAuthStatus
      activeProfileId: string
      profiles: HiveWardProfileSummary[]
      profile: HiveWardProfileSummary
    }
  | {
      status: 'unconfigured' | 'reconnect-required'
      auth: HiveWardProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: HiveWardProfileAuthStatus
      error: string
    }

export type SignOutCurrentHiveWardProfileResult = {
  status: 'signed-out'
  auth: HiveWardProfileAuthStatus
  activeProfileId: string
  profiles: HiveWardProfileSummary[]
}

export type SelectHiveWardProfileOrgArgs = {
  orgId: string
}

export type SelectHiveWardProfileOrgResult =
  | {
      status: 'selected'
      auth: HiveWardProfileAuthStatus
      activeProfileId: string
      profiles: HiveWardProfileSummary[]
    }
  | {
      status: 'unconfigured' | 'reconnect-required'
      auth: HiveWardProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: HiveWardProfileAuthStatus
      error: string
    }

export type RefreshCurrentHiveWardProfileAuthResult =
  | {
      status: 'refreshed'
      auth: HiveWardProfileAuthStatus
      activeProfileId: string
      profiles: HiveWardProfileSummary[]
    }
  | {
      status: 'local' | 'unconfigured' | 'reconnect-required'
      auth: HiveWardProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: HiveWardProfileAuthStatus
      error: string
    }

// Mirror the server’s fixed role enum so UI options cannot drift from accepted API values.
export type HiveWardOrgRole = 'owner' | 'admin' | 'member'

export type HiveWardOrgMember = {
  // Provisioned teammates without sign-in have no userId; disable mutations requiring that key.
  userId: string | null
  email: string
  displayName?: string
  role: HiveWardOrgRole
}

export type HiveWardOrgPendingInvite = {
  email: string
  role: HiveWardOrgRole
  createdAt: number
}

export type HiveWardOrgMembersRoster = {
  members: HiveWardOrgMember[]
  pendingInvites: HiveWardOrgPendingInvite[]
  viewerRole: HiveWardOrgRole
  canManageMembers: boolean
}

export type HiveWardProfileOrgMembersListArgs = {
  orgId: string
}

export type HiveWardProfileOrgMemberInviteArgs = {
  orgId: string
  email: string
  role: HiveWardOrgRole
}

export type HiveWardProfileOrgInviteRevokeArgs = {
  orgId: string
  email: string
}

export type HiveWardProfileOrgMemberChangeRoleArgs = {
  orgId: string
  userId: string
  role: HiveWardOrgRole
}

export type HiveWardProfileOrgMemberRemoveArgs = {
  orgId: string
  userId: string
}

export type HiveWardProfileOrgMembersListResult =
  | { status: 'ok'; roster: HiveWardOrgMembersRoster }
  | { status: 'unconfigured' | 'reconnect-required' }
  | { status: 'failed'; error: string }

export type HiveWardOrgInviteConflictReason = 'already_member' | 'already_invited'
export type HiveWardOrgMutationInvalidReason = 'cannot_change_own_role' | 'cannot_remove_self'

export type HiveWardProfileOrgMemberMutationResult =
  | { status: 'ok' }
  | { status: 'unconfigured' | 'reconnect-required' | 'forbidden' | 'not-found' }
  | { status: 'conflict'; reason: HiveWardOrgInviteConflictReason }
  | { status: 'invalid'; reason: HiveWardOrgMutationInvalidReason }
  | { status: 'failed'; error: string }

export function createDefaultLocalHiveWardProfile(now: number): HiveWardProfileSummary {
  return {
    id: DEFAULT_LOCAL_HIVEWARD_PROFILE_ID,
    name: DEFAULT_LOCAL_HIVEWARD_PROFILE_NAME,
    avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
    kind: 'local',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  }
}

function profilePartitionHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function getHiveWardProfileBrowserPartitionSegment(profileId: string): string {
  const safe = profileId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'profile'
  return `${safe}-${profilePartitionHash(profileId)}`
}

export function getHiveWardProfileBrowserDefaultPartition(profileId: string): string {
  if (profileId === DEFAULT_LOCAL_HIVEWARD_PROFILE_ID) {
    return HIVEWARD_BROWSER_PARTITION
  }
  return `persist:hiveward-profile-${getHiveWardProfileBrowserPartitionSegment(profileId)}-browser-default`
}

export function getHiveWardProfileBrowserSessionPartition(
  profileId: string,
  browserSessionProfileId: string
): string {
  if (profileId === DEFAULT_LOCAL_HIVEWARD_PROFILE_ID) {
    return `${LEGACY_HIVEWARD_BROWSER_SESSION_PARTITION_PREFIX}${browserSessionProfileId}`
  }
  return `persist:hiveward-profile-${getHiveWardProfileBrowserPartitionSegment(
    profileId
  )}-browser-session-${browserSessionProfileId}`
}
