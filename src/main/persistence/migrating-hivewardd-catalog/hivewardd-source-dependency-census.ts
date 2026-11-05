import type { HivewarddMigrationManifest } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import {
  HIVEWARDD_MIGRATION_DEPENDENCY_KINDS,
  type HivewarddMigrationDependencyKind
} from '../../../shared/hivewardd-migration/hivewardd-migration-preflight'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import {
  inspectHivewarddMigrationSourceSessions,
  type HivewarddMigrationSourceSessionInspection
} from './hivewardd-source-session-dependencies'
import {
  collectHivewarddMigrationSourceDormantState,
  hivewarddMigrationLeavesBehind
} from './hivewardd-source-dormant-state'
import {
  createHivewarddMigrationSourceScope,
  hivewarddMigrationOwnerMatchesScope,
  hivewarddMigrationPartitionScope,
  type HivewarddMigrationSourceScope
} from './hivewardd-source-scope'
import { paneBelongsToTabs } from '../../../shared/workspace-session-pane-ownership'

export type HivewarddMigrationSourceDependencyCensus = {
  totalCount: number
  counts: Record<HivewarddMigrationDependencyKind, number>
  /** Blocker names and remedies where available. */
  names?: Partial<Record<HivewarddMigrationDependencyKind, string[]>>
}

export function collectHivewarddMigrationUntransferredDependencyCensus(
  state: PersistedState,
  manifest: HivewarddMigrationManifest,
  storage?: TerminalScrollbackSnapshotStorage
): HivewarddMigrationSourceDependencyCensus {
  const scope = createHivewarddMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  const sessions = inspectHivewarddMigrationSourceSessions(state, {
    hostId: scope.hostId,
    ownerMatches: (ownerKey, partitionHostId) =>
      hivewarddMigrationOwnerMatchesScope(
        ownerKey,
        hivewarddMigrationPartitionScope(scope, partitionHostId)
      )
  })
  const dormant = collectHivewarddMigrationSourceDormantState(
    state,
    manifest.source,
    manifest.payload,
    storage,
    manifest.destinationEnvironmentId
  )
  const counts: Record<HivewarddMigrationDependencyKind, number> = {
    ...dormant.blockedCounts,
    'terminal-lease': state.sshRemotePtyLeases.filter(
      (lease) => lease.targetId === scope.targetId && lease.state !== 'terminated'
    ).length,
    // Retained recoveries can stay behind; the terminal gate still requires exit.
    'terminal-recovery': hivewarddMigrationLeavesBehind(state, scope.targetId)
      ? 0
      : countTerminalRecoveryState(state, scope, sessions)
  }
  return {
    counts,
    totalCount: HIVEWARDD_MIGRATION_DEPENDENCY_KINDS.reduce((total, kind) => total + counts[kind], 0),
    names: {
      ...(dormant.blockedSessionItems.length > 0
        ? { 'workspace-session': dormant.blockedSessionItems }
        : {}),
      ...(dormant.runningAutomationItems.length > 0
        ? { 'automation-run': dormant.runningAutomationItems }
        : {})
    }
  }
}

// The terminal gate proves recovery leases exited; hook aliases add no independent terminal ownership.
function countTerminalRecoveryState(
  state: PersistedState,
  scope: HivewarddMigrationSourceScope,
  sessions: HivewarddMigrationSourceSessionInspection
): number {
  return state.migrationUnsupportedPtyEntries.filter(
    (entry) =>
      hivewarddMigrationOwnerMatchesScope(entry.worktreeId, scope) ||
      (entry.tabId ? sessions.tabIds.has(entry.tabId) : false) ||
      sessions.ptyIds.has(entry.ptyId) ||
      (entry.paneKey ? paneBelongsToTabs(entry.paneKey, sessions.tabIds) : false)
  ).length
}
