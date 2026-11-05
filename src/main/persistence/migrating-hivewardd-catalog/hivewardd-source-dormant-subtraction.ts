import type { HivewarddMigrationManifest } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { subtractHivewarddSourceWorktreeMetadata } from './hivewardd-source-worktree-metadata'
import { subtractHivewarddMigrationSourceAutomationState } from './hivewardd-source-automation-subtraction'
import { subtractHivewarddMigrationSourceWorkspaceSession } from './hivewardd-source-workspace-session-subtraction'
import { subtractHivewarddMigrationClientState } from './hivewardd-source-client-subtraction'

/** Mutate a delta-view copy only. */
export function subtractHivewarddMigrationSourceDormantState(
  state: PersistedState,
  manifest: HivewarddMigrationManifest
): void {
  // Include state a downgraded build added even when the manifest had none.
  subtractHivewarddSourceWorktreeMetadata(state, manifest)
  subtractHivewarddMigrationSourceAutomationState(state, manifest)
  const dormant = manifest.payload.dormantState
  if (!dormant) {
    return
  }
  dormant.worktreeLineage.forEach((entry) => delete state.worktreeLineageById[entry.sourceKey])
  dormant.workspaceLineage.forEach(
    (entry) => delete state.workspaceLineageByChildKey[entry.sourceKey]
  )
  for (const preset of dormant.sparsePresets) {
    const remaining = (state.sparsePresetsByRepo[preset.repoId] ?? []).filter(
      (entry) => entry.id !== preset.id
    )
    if (remaining.length > 0) {
      state.sparsePresetsByRepo[preset.repoId] = remaining
    } else {
      delete state.sparsePresetsByRepo[preset.repoId]
    }
  }
  for (const entry of dormant.retiredWorktreeNames) {
    delete state.retiredWorktreeNamesByRepo?.[entry.repoId]
  }
  subtractHivewarddMigrationSourceWorkspaceSession(state, manifest)
  subtractHivewarddMigrationClientState(state, manifest)
  // Retain snapshot files: the prior durable profile and rollback evidence can still reference them.
}
