import { getAutomationRunRepoId } from '../../../shared/automation-run-identity'
import type { HivewarddMigrationManifest } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { createHivewarddMigrationSourceScope, hivewarddMigrationOwnsRepoId } from './hivewardd-source-scope'

/** Include rows a downgraded build added to moved projects. */
export function subtractHivewarddMigrationSourceAutomationState(
  state: PersistedState,
  manifest: HivewarddMigrationManifest
): void {
  const scope = createHivewarddMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  const automationIds = new Set([
    ...(manifest.payload.dormantState?.automations ?? []).map((entry) => entry.id),
    ...state.automations
      .filter(
        (entry) =>
          hivewarddMigrationOwnsRepoId(scope, getAutomationRunRepoId(entry)) &&
          (entry.executionTargetType !== 'ssh' || entry.executionTargetId === scope.targetId)
      )
      .map((entry) => entry.id)
  ])
  const runIds = new Set((manifest.payload.dormantState?.automationRuns ?? []).map((run) => run.id))
  state.automations = state.automations.filter((entry) => !automationIds.has(entry.id))
  state.automationRuns = state.automationRuns.filter(
    (run) => !runIds.has(run.id) && !automationIds.has(run.automationId)
  )
}
