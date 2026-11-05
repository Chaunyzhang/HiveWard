// Delta-view copies only: remove still-owned manifest rows; retain groups referenced elsewhere.
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { HivewarddMigrationManifest } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import { requireHivewarddMigrationSshSource } from '../../../shared/hivewardd-migration/hivewardd-migration-source-kind'
import { hivewarddSourceFolderWorkspaceIds, repoBelongsToHivewarddSource } from './hivewardd-source-ownership'

export function subtractHivewarddSourceCatalogState(
  state: StoreRuntimeState['state'],
  manifest: HivewarddMigrationManifest
): void {
  const repoIds = new Set(manifest.payload.repositories.map((repo) => repo.id))
  const folderIds = new Set(manifest.payload.folderWorkspaces.map((workspace) => workspace.id))
  const groupIds = new Set(manifest.payload.projectGroups.map((group) => group.id))
  const targetId = requireHivewarddMigrationSshSource(manifest.source).sshTargetId
  // Resolve inferred folder ownership before deleting its repos.
  const ownedFolderIds = hivewarddSourceFolderWorkspaceIds(state, targetId)
  state.repos = state.repos.filter(
    (repo) => !(repoIds.has(repo.id) && repoBelongsToHivewarddSource(repo, targetId))
  )
  state.folderWorkspaces = state.folderWorkspaces.filter(
    (workspace) => !(folderIds.has(workspace.id) && ownedFolderIds.has(workspace.id))
  )
  removeUnreferencedSourceGroups(state, groupIds, targetId)
}

function removeUnreferencedSourceGroups(
  state: StoreRuntimeState['state'],
  candidateIds: ReadonlySet<string>,
  targetId: string
): void {
  let removed = true
  while (removed) {
    removed = false
    const referencedIds = new Set([
      ...state.repos.flatMap((repo) => (repo.projectGroupId ? [repo.projectGroupId] : [])),
      ...state.folderWorkspaces.map((workspace) => workspace.projectGroupId),
      ...state.projectGroups.flatMap((group) => (group.parentGroupId ? [group.parentGroupId] : []))
    ])
    const next = state.projectGroups.filter((group) => {
      const shouldRemove =
        candidateIds.has(group.id) &&
        group.connectionId === targetId &&
        !referencedIds.has(group.id)
      removed ||= shouldRemove
      return !shouldRemove
    })
    state.projectGroups = next
  }
}
