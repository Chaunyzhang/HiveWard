// Offer "Move anyway" only when a consent-free preview shows it clears the blockers.
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { collectHivewarddMigrationUntransferredDependencyCensus } from './hivewardd-source-dependency-census'
import { collectHivewarddMigrationSourceDormantState } from './hivewardd-source-dormant-state'
import type { HivewarddMigrationDeltaView } from './hivewardd-source-delta-view'

export function createHivewarddMigrationLeaveBehindView(
  runtime: Pick<StoreRuntimeState, 'state' | 'terminalScrollbackSnapshotStorage'>,
  targetId: string
): HivewarddMigrationDeltaView {
  // Read-only collectors make a shallow copy sufficient.
  const state = {
    ...runtime.state,
    sshTargets: runtime.state.sshTargets.map((target) =>
      target.id === targetId
        ? { ...target, managedServerLeaveBehind: { confirmedAt: new Date(0).toISOString() } }
        : target
    )
  }
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
