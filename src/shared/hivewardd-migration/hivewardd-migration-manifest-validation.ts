import type { FolderWorkspace } from '../folder-workspace-types'
import type {
  HivewarddMigrationCatalogPayload,
  HivewarddMigrationImportReceipt,
  HivewarddMigrationManifest,
  HivewarddMigrationManifestSource
} from './hivewardd-migration-manifest'
import {
  assertLocalWslScopeMatchesPayload,
  parseLocalWslSource
} from './hivewardd-migration-wsl-source-validation'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import {
  MAX_HIVEWARDD_MIGRATION_FOLDER_WORKSPACES,
  MAX_HIVEWARDD_MIGRATION_REPOSITORIES,
  assertUniqueIds,
  boundedArray,
  boundedStringArray,
  isRecord,
  requiredDate,
  requiredFiniteNumber,
  requiredString
} from './hivewardd-migration-manifest-fields'
import {
  assertHivewarddMigrationDormantStateReferences,
  parseHivewarddMigrationDormantState
} from '../hivewardd-migration-dormant-state-validation'

export { MAX_HIVEWARDD_MIGRATION_FOLDER_WORKSPACES, MAX_HIVEWARDD_MIGRATION_REPOSITORIES }
export const HIVEWARDD_MIGRATION_MANIFEST_VERSION = 1 as const
export type HivewarddMigrationManifestVersion = typeof HIVEWARDD_MIGRATION_MANIFEST_VERSION
export const MAX_HIVEWARDD_MIGRATION_MANIFEST_BYTES = 768 * 1024
export const MAX_HIVEWARDD_MIGRATION_PROJECT_GROUPS = 4_096
export const MAX_HIVEWARDD_MIGRATION_IMPORT_RECEIPTS = 64

export function parseHivewarddMigrationManifest(value: unknown): HivewarddMigrationManifest {
  if (!isRecord(value)) {
    throw new Error('hivewardd_migration_manifest_invalid')
  }
  if (value.version !== HIVEWARDD_MIGRATION_MANIFEST_VERSION) {
    throw new Error('hivewardd_migration_manifest_version_unsupported')
  }
  const migrationId = requiredString(value.migrationId, 'migrationId')
  const createdAt = requiredDate(value.createdAt, 'createdAt')
  const source = parseSource(value.source)
  const payload = parsePayload(value.payload)
  const manifestSha256 = requiredString(value.manifestSha256, 'manifestSha256')
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) {
    throw new Error('hivewardd_migration_manifest_digest_invalid')
  }
  const manifest: HivewarddMigrationManifest = {
    version: HIVEWARDD_MIGRATION_MANIFEST_VERSION,
    migrationId,
    createdAt,
    source,
    payload,
    ...(value.destinationEnvironmentId === undefined
      ? {}
      : {
          destinationEnvironmentId: requiredString(
            value.destinationEnvironmentId,
            'destinationEnvironmentId'
          )
        }),
    manifestSha256
  }
  const bytes = new TextEncoder().encode(JSON.stringify(manifest)).byteLength
  if (bytes > MAX_HIVEWARDD_MIGRATION_MANIFEST_BYTES) {
    throw new Error('hivewardd_migration_manifest_too_large')
  }
  assertLocalWslScopeMatchesPayload(manifest)
  return manifest
}

export function normalizeHivewarddMigrationImportReceipts(
  value: unknown
): HivewarddMigrationImportReceipt[] {
  if (!Array.isArray(value)) {
    return []
  }
  const receipts: HivewarddMigrationImportReceipt[] = []
  const seen = new Set<string>()
  for (let index = value.length - 1; index >= 0; index--) {
    try {
      const receipt = parseReceipt(value[index])
      if (!seen.has(receipt.migrationId)) {
        seen.add(receipt.migrationId)
        receipts.push(receipt)
        if (receipts.length === MAX_HIVEWARDD_MIGRATION_IMPORT_RECEIPTS) {
          break
        }
      }
    } catch {
      // Invalid receipts cannot prove an import and are dropped fail-closed.
    }
  }
  // Keep persisted receipts readable in the documented Node 18 rollback slot.
  return receipts.reduceRight<HivewarddMigrationImportReceipt[]>((reversed, receipt) => {
    reversed.push(receipt)
    return reversed
  }, [])
}

function parsePayload(value: unknown): HivewarddMigrationCatalogPayload {
  if (!isRecord(value)) {
    throw new Error('hivewardd_migration_manifest_payload_invalid')
  }
  const repositories = boundedArray(
    value.repositories,
    MAX_HIVEWARDD_MIGRATION_REPOSITORIES,
    parseRepository,
    'repositories'
  )
  const projectGroups = boundedArray(
    value.projectGroups,
    MAX_HIVEWARDD_MIGRATION_PROJECT_GROUPS,
    parseProjectGroup,
    'projectGroups'
  )
  const folderWorkspaces = boundedArray(
    value.folderWorkspaces,
    MAX_HIVEWARDD_MIGRATION_FOLDER_WORKSPACES,
    parseFolderWorkspace,
    'folderWorkspaces'
  )
  assertUniqueIds(repositories, 'repositories')
  assertUniqueIds(projectGroups, 'projectGroups')
  assertUniqueIds(folderWorkspaces, 'folderWorkspaces')
  const dormantState =
    value.dormantState === undefined
      ? undefined
      : parseHivewarddMigrationDormantState(value.dormantState)
  if (dormantState) {
    assertHivewarddMigrationDormantStateReferences({
      dormantState,
      repositoryIds: new Set(repositories.map((repo) => repo.id)),
      folderWorkspaceIds: new Set(folderWorkspaces.map((workspace) => workspace.id))
    })
  }
  return {
    repositories,
    projectGroups,
    folderWorkspaces,
    ...(dormantState ? { dormantState } : {})
  }
}

function parseSource(value: unknown): HivewarddMigrationManifestSource {
  if (!isRecord(value)) {
    throw new Error('hivewardd_migration_manifest_source_invalid')
  }
  if (value.kind === 'local-wsl') {
    return parseLocalWslSource(value)
  }
  // An explicit 'ssh-relay' is refused too: SSH has exactly one encoding, so one digest.
  if (value.kind !== undefined) {
    throw new Error('hivewardd_migration_manifest_source_kind_unsupported')
  }
  const generation = value.sshTargetGeneration
  if (generation !== null && (!Number.isSafeInteger(generation) || Number(generation) < 1)) {
    throw new Error('hivewardd_migration_manifest_source_generation_invalid')
  }
  return {
    sshTargetId: requiredString(value.sshTargetId, 'source.sshTargetId'),
    sshTargetGeneration: generation === null ? null : Number(generation),
    targetLabel: requiredString(value.targetLabel, 'source.targetLabel')
  }
}

function parseRepository(value: unknown): Repo {
  const copy = structuredClone(value)
  if (!isMigratedRepository(copy)) {
    throw new Error('hivewardd_migration_manifest_repository_invalid')
  }
  return copy
}

// SAFETY: checks the fields import reads and throws the specific error; the rest pass through as
// the client's own load normalized them.
function isMigratedRepository(value: unknown): value is Repo {
  if (!isRecord(value)) {
    throw new Error('hivewardd_migration_manifest_repository_invalid')
  }
  requiredString(value.id, 'repository.id')
  requiredString(value.path, 'repository.path')
  requiredString(value.displayName, 'repository.displayName')
  requiredString(value.badgeColor, 'repository.badgeColor')
  requiredFiniteNumber(value.addedAt, 'repository.addedAt')
  if (value.kind !== undefined && value.kind !== 'git' && value.kind !== 'folder') {
    throw new Error('hivewardd_migration_manifest_repository_kind_invalid')
  }
  return true
}

function parseProjectGroup(value: unknown): ProjectGroup {
  const copy = structuredClone(value)
  if (!isMigratedProjectGroup(copy)) {
    throw new Error('hivewardd_migration_manifest_project_group_invalid')
  }
  return copy
}

// SAFETY: checks the fields import reads and throws the specific error; the rest pass through as
// the client's own load normalized them.
function isMigratedProjectGroup(value: unknown): value is ProjectGroup {
  if (!isRecord(value)) {
    throw new Error('hivewardd_migration_manifest_project_group_invalid')
  }
  requiredString(value.id, 'projectGroup.id')
  requiredString(value.name, 'projectGroup.name')
  requiredFiniteNumber(value.tabOrder, 'projectGroup.tabOrder')
  requiredFiniteNumber(value.createdAt, 'projectGroup.createdAt')
  requiredFiniteNumber(value.updatedAt, 'projectGroup.updatedAt')
  if (value.parentPath !== null && typeof value.parentPath !== 'string') {
    throw new Error('hivewardd_migration_manifest_project_group_parent_path_invalid')
  }
  if (value.parentGroupId !== null && typeof value.parentGroupId !== 'string') {
    throw new Error('hivewardd_migration_manifest_project_group_parent_invalid')
  }
  if (typeof value.isCollapsed !== 'boolean') {
    throw new Error('hivewardd_migration_manifest_project_group_collapsed_invalid')
  }
  if (value.color !== null && typeof value.color !== 'string') {
    throw new Error('hivewardd_migration_manifest_project_group_color_invalid')
  }
  if (!['manual', 'folder-scan', 'migration'].includes(String(value.createdFrom))) {
    throw new Error('hivewardd_migration_manifest_project_group_origin_invalid')
  }
  return true
}

function parseFolderWorkspace(value: unknown): FolderWorkspace {
  const copy = structuredClone(value)
  if (!isMigratedFolderWorkspace(copy)) {
    throw new Error('hivewardd_migration_manifest_folder_workspace_invalid')
  }
  return copy
}

// SAFETY: checks the fields import reads and throws the specific error; the rest pass through as
// the client's own load normalized them.
function isMigratedFolderWorkspace(value: unknown): value is FolderWorkspace {
  if (!isRecord(value)) {
    throw new Error('hivewardd_migration_manifest_folder_workspace_invalid')
  }
  requiredString(value.id, 'folderWorkspace.id')
  requiredString(value.projectGroupId, 'folderWorkspace.projectGroupId')
  requiredString(value.name, 'folderWorkspace.name')
  requiredString(value.folderPath, 'folderWorkspace.folderPath')
  requiredFiniteNumber(value.sortOrder, 'folderWorkspace.sortOrder')
  requiredFiniteNumber(value.lastActivityAt, 'folderWorkspace.lastActivityAt')
  requiredFiniteNumber(value.createdAt, 'folderWorkspace.createdAt')
  requiredFiniteNumber(value.updatedAt, 'folderWorkspace.updatedAt')
  for (const key of ['isArchived', 'isUnread', 'isPinned'] as const) {
    if (typeof value[key] !== 'boolean') {
      throw new Error(`hivewardd_migration_manifest_folder_workspace_${key}_invalid`)
    }
  }
  return true
}

function parseReceipt(value: unknown): HivewarddMigrationImportReceipt {
  if (!isRecord(value) || value.version !== HIVEWARDD_MIGRATION_MANIFEST_VERSION) {
    throw new Error('hivewardd_migration_receipt_invalid')
  }
  const manifestSha256 = requiredString(value.manifestSha256, 'receipt.manifestSha256')
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) {
    throw new Error('hivewardd_migration_receipt_digest_invalid')
  }
  return {
    version: HIVEWARDD_MIGRATION_MANIFEST_VERSION,
    migrationId: requiredString(value.migrationId, 'receipt.migrationId'),
    manifestSha256,
    source: parseSource(value.source),
    importedAt: requiredDate(value.importedAt, 'receipt.importedAt'),
    repositoryIds: boundedStringArray(
      value.repositoryIds,
      MAX_HIVEWARDD_MIGRATION_REPOSITORIES,
      'receipt.repositoryIds_invalid'
    ),
    projectGroupIds: boundedStringArray(
      value.projectGroupIds,
      MAX_HIVEWARDD_MIGRATION_PROJECT_GROUPS,
      'receipt.projectGroupIds_invalid'
    ),
    folderWorkspaceIds: boundedStringArray(
      value.folderWorkspaceIds,
      MAX_HIVEWARDD_MIGRATION_FOLDER_WORKSPACES,
      'receipt.folderWorkspaceIds_invalid'
    )
  }
}
