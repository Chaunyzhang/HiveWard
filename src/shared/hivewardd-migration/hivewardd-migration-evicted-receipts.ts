/** Keep enough of evicted receipts to answer committed; derive the remaining receipt from its manifest. */
import { isRecord } from './hivewardd-migration-manifest-fields'

export const MAX_HIVEWARDD_MIGRATION_EVICTED_RECEIPTS = 4_096

export type HivewarddMigrationEvictedReceipt = {
  migrationId: string
  manifestSha256: string
  importedAt: string
}

export function normalizeHivewarddMigrationEvictedReceipts(
  value: unknown
): HivewarddMigrationEvictedReceipt[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter(
      (entry): entry is HivewarddMigrationEvictedReceipt =>
        isRecord(entry) &&
        typeof entry.migrationId === 'string' &&
        entry.migrationId.length > 0 &&
        typeof entry.manifestSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(entry.manifestSha256) &&
        typeof entry.importedAt === 'string' &&
        Number.isFinite(Date.parse(entry.importedAt))
    )
    .map(({ migrationId, manifestSha256, importedAt }) => ({
      migrationId,
      manifestSha256,
      importedAt
    }))
    .slice(-MAX_HIVEWARDD_MIGRATION_EVICTED_RECEIPTS)
}
