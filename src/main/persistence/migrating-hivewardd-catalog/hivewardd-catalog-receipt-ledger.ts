// Commit receipts remain authoritative indefinitely; abandoned stages expire.
import { MAX_HIVEWARDD_MIGRATION_IMPORT_RECEIPTS } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest-validation'
import type {
  HivewarddMigrationImportReceipt,
  HivewarddMigrationManifest
} from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import { MAX_HIVEWARDD_MIGRATION_EVICTED_RECEIPTS } from '../../../shared/hivewardd-migration/hivewardd-migration-evicted-receipts'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  hivewarddMigrationStagingKey,
  type HivewarddMigrationRequestIdentity
} from './hivewardd-migration-staged-file'

// Allow a week for clients that went offline mid-move.
export const HIVEWARDD_MIGRATION_STAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function findHivewarddMigrationImportReceipt(
  state: PersistedState,
  manifest: HivewarddMigrationManifest
): HivewarddMigrationImportReceipt | undefined {
  const receipt = state.hivewarddMigrationImportReceipts?.find(
    (entry) => entry.migrationId === manifest.migrationId
  )
  if (receipt) {
    return receipt
  }
  const evicted = state.hivewarddMigrationEvictedReceipts?.find(
    (entry) => entry.migrationId === manifest.migrationId
  )
  // Rebuild the remaining receipt fields from the manifest.
  return evicted
    ? {
        version: manifest.version,
        migrationId: evicted.migrationId,
        manifestSha256: evicted.manifestSha256,
        source: structuredClone(manifest.source),
        importedAt: evicted.importedAt,
        repositoryIds: manifest.payload.repositories.map((repo) => repo.id),
        projectGroupIds: manifest.payload.projectGroups.map((group) => group.id),
        folderWorkspaceIds: manifest.payload.folderWorkspaces.map((workspace) => workspace.id)
      }
    : undefined
}

/** Compact evicted receipts without losing proof of commit. */
export function recordHivewarddMigrationImportReceipt(
  state: PersistedState,
  receipt: HivewarddMigrationImportReceipt
): void {
  const receipts = [...(state.hivewarddMigrationImportReceipts ?? []), receipt]
  const overflow = receipts.length - MAX_HIVEWARDD_MIGRATION_IMPORT_RECEIPTS
  if (overflow > 0) {
    state.hivewarddMigrationEvictedReceipts = [
      ...(state.hivewarddMigrationEvictedReceipts ?? []),
      ...receipts.slice(0, overflow).map(({ migrationId, manifestSha256, importedAt }) => ({
        migrationId,
        manifestSha256,
        importedAt
      }))
    ].slice(-MAX_HIVEWARDD_MIGRATION_EVICTED_RECEIPTS)
  }
  state.hivewarddMigrationImportReceipts = receipts.slice(-MAX_HIVEWARDD_MIGRATION_IMPORT_RECEIPTS)
}

export function isLiveHivewarddMigrationStage(stagedAt: string, now: number): boolean {
  return now - Date.parse(stagedAt) < HIVEWARDD_MIGRATION_STAGE_TTL_MS
}

export function expireHivewarddMigrationStages(state: PersistedState, now: number): boolean {
  const staged = state.hivewarddMigrationStagedCatalogs ?? []
  const live = staged.filter((entry) => isLiveHivewarddMigrationStage(entry.stagedAt, now))
  if (live.length === staged.length) {
    return false
  }
  state.hivewarddMigrationStagedCatalogs = live
  return true
}

export type HivewarddMigrationCommitGenerationRuntime = Pick<
  StoreRuntimeState,
  'writeGeneration' | 'lastDurableWriteGeneration' | 'hivewarddMigrationCommitWriteGenerations'
>

/** Call right after the commit's `scheduleSave`; `generationBefore` is read just before it. */
export function recordHivewarddMigrationCommitWriteGeneration(
  runtime: HivewarddMigrationCommitGenerationRuntime,
  migration: HivewarddMigrationRequestIdentity,
  generationBefore: number
): void {
  // Suppressed saves never advance generation; only a disk-loaded receipt can prove durability.
  runtime.hivewarddMigrationCommitWriteGenerations.set(
    hivewarddMigrationStagingKey(migration),
    runtime.writeGeneration > generationBefore ? runtime.writeGeneration : Number.POSITIVE_INFINITY
  )
}

/** Require disk durability before consuming blobs a restart might need to retry. */
export function isHivewarddMigrationCommitDurable(
  runtime: HivewarddMigrationCommitGenerationRuntime,
  migration: HivewarddMigrationRequestIdentity
): boolean {
  const key = hivewarddMigrationStagingKey(migration)
  const required = runtime.hivewarddMigrationCommitWriteGenerations.get(key)
  if (required === undefined) {
    return true
  }
  if (runtime.lastDurableWriteGeneration < required) {
    return false
  }
  runtime.hivewarddMigrationCommitWriteGenerations.delete(key)
  return true
}
