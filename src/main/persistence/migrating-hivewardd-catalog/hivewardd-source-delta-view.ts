// Export only additions from older builds by subtracting prior migrations from a profile copy.
import type {
  HivewarddMigrationCatalogPayload,
  HivewarddMigrationDormantStatePayload,
  HivewarddMigrationManifest,
  HivewarddMigrationManifestSource
} from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { subtractHivewarddSourceCatalogState } from './hivewardd-source-catalog-subtraction'
import {
  collectHivewarddMigrationUntransferredDependencyCensus,
  type HivewarddMigrationSourceDependencyCensus
} from './hivewardd-source-dependency-census'
import { subtractHivewarddMigrationSourceDormantState } from './hivewardd-source-dormant-subtraction'
import { collectHivewarddMigrationSourceDormantState } from './hivewardd-source-dormant-state'
import { subtractHivewarddMigrationScopeWorkspaceSession } from './hivewardd-source-workspace-session-subtraction'

export type HivewarddMigrationDeltaView = {
  getRepos: () => Repo[]
  getFolderWorkspaces: () => FolderWorkspace[]
  getProjectGroups: () => ProjectGroup[]
  collectHivewarddMigrationSourceDormantState: (
    source: HivewarddMigrationManifestSource,
    catalog: HivewarddMigrationCatalogPayload,
    destinationEnvironmentId?: string
  ) => HivewarddMigrationDormantStatePayload
  inspectHivewarddMigrationUntransferredDependencies: (
    manifest: HivewarddMigrationManifest
  ) => HivewarddMigrationSourceDependencyCensus
}

/** moved includes today's edits to previously migrated rows. */
export function createHivewarddMigrationDeltaView(
  runtime: Pick<StoreRuntimeState, 'state' | 'terminalScrollbackSnapshotStorage'>,
  moved: HivewarddMigrationManifest
): HivewarddMigrationDeltaView {
  const state = structuredClone(runtime.state)
  subtractHivewarddSourceCatalogState(state, moved)
  subtractHivewarddMigrationSourceDormantState(state, moved)
  // The server owns the moved projects' tabs now, even ones the older build left unmovable.
  subtractHivewarddMigrationScopeWorkspaceSession(state, moved)
  const storage = runtime.terminalScrollbackSnapshotStorage
  return {
    getRepos: () => state.repos,
    getFolderWorkspaces: () => state.folderWorkspaces,
    getProjectGroups: () => state.projectGroups,
    collectHivewarddMigrationSourceDormantState: (source, catalog, destinationEnvironmentId) =>
      collectHivewarddMigrationSourceDormantState(
        state,
        source,
        catalog,
        storage,
        destinationEnvironmentId
      ).payload,
    inspectHivewarddMigrationUntransferredDependencies: (manifest) =>
      collectHivewarddMigrationUntransferredDependencyCensus(state, manifest, storage)
  }
}
