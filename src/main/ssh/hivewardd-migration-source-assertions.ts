import { createHash } from 'node:crypto'
import {
  serializeHivewarddMigrationValue,
  type HivewarddMigrationManifest
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { HivewarddMigrationSourceCutover } from '../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import { createHivewarddMigrationManifest } from './hivewardd-migration-manifest-export'
import { resolveHivewarddMigrationFence } from './hivewardd-migration-source-fence'
import { confirmHivewarddMigrationTerminalsUnderFence } from './hivewardd-migration-terminal-gate'
import { collectUntransferredDependentBlockers } from './targets/ssh-target-hivewardd-dependents'
import type { HivewarddMigrationPreflightStore } from './targets/ssh-target-hivewardd-preflight'

export function assertHivewarddMigrationSourceUnchanged(
  context: { userDataPath: string; store: HivewarddMigrationPreflightStore },
  cutover: HivewarddMigrationSourceCutover
): void {
  const target = context.store.getSshTarget(cutover.sshTargetId)
  const fence = target ? resolveHivewarddMigrationFence(context.userDataPath, target) : null
  if (!target || fence?.state !== 'fenced' || fence.cutover.migrationId !== cutover.migrationId) {
    throw new Error('hivewardd_migration_source_fence_lost')
  }
  // Re-export with journaled identity/time/destination so only source changes affect comparison.
  const current = createHivewarddMigrationManifest(context.store, target, {
    migrationId: cutover.migrationId,
    destinationEnvironmentId: cutover.destinationEnvironmentId,
    now: () => new Date(cutover.manifest.createdAt)
  })
  if (frozenSourceDigest(current) !== frozenSourceDigest(cutover.manifest)) {
    throw new Error('hivewardd_migration_source_changed')
  }
  if (collectUntransferredDependentBlockers(context.store, cutover.manifest).length > 0) {
    throw new Error('hivewardd_migration_source_dependencies_present')
  }
  const terminals = confirmHivewarddMigrationTerminalsUnderFence(
    context.store,
    target.id,
    cutover.bridgedPtyIds
      ? {
          verdict: 'bridged',
          relayVerdict: 'unverifiable',
          bridgedPtyIds: cutover.bridgedPtyIds,
          hostTerminals: 0
        }
      : { verdict: 'exited', provenPtyIds: cutover.provenPtyIds }
  )
  if (terminals.verdict === 'live' || terminals.verdict === 'unverifiable') {
    throw new Error(`hivewardd_migration_source_terminals_${terminals.verdict}`)
  }
}

/** Ignore mutable UI layout/focus/routing: the destination gets the journaled view, and tab churn must not invalidate migration. */
function frozenSourceDigest(manifest: HivewarddMigrationManifest): string {
  const { manifestSha256: _digest, payload, ...rest } = manifest
  const {
    version: _version,
    workspaceSession: _session,
    clientState: _client,
    // Retention preserves journaled bytes even if their tab closes during transfer.
    terminalScrollbackSnapshots: _snapshots,
    ...dormant
  } = payload.dormantState ?? {}
  // UI-only changes can introduce a dormant payload that export previously omitted as empty.
  const empty = Object.values(dormant).every(
    (value) => value === undefined || (Array.isArray(value) && value.length === 0)
  )
  const frozen = { ...rest, payload: { ...payload, dormantState: empty ? undefined : dormant } }
  return createHash('sha256').update(serializeHivewarddMigrationValue(frozen)).digest('hex')
}
