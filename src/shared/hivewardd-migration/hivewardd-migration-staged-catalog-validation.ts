import type { HivewarddMigrationStagedCatalog } from './hivewardd-migration-manifest'
import {
  HIVEWARDD_MIGRATION_MANIFEST_VERSION,
  parseHivewarddMigrationManifest
} from './hivewardd-migration-manifest-validation'
import { isRecord } from './hivewardd-migration-manifest-fields'

export const MAX_HIVEWARDD_MIGRATION_STAGED_CATALOGS = 4

export function normalizeHivewarddMigrationStagedCatalogs(
  value: unknown
): HivewarddMigrationStagedCatalog[] {
  if (!Array.isArray(value)) {
    return []
  }
  const staged: HivewarddMigrationStagedCatalog[] = []
  const seen = new Set<string>()
  for (let index = value.length - 1; index >= 0; index--) {
    try {
      const entry = parseStagedCatalog(value[index])
      if (!seen.has(entry.manifest.migrationId)) {
        seen.add(entry.manifest.migrationId)
        staged.push(entry)
        if (staged.length === MAX_HIVEWARDD_MIGRATION_STAGED_CATALOGS) {
          break
        }
      }
    } catch {
      // Invalid staging cannot prove fencing; drop it fail-closed.
    }
  }
  // Keep the migration journal runnable in the documented Node 18 rollback slot.
  return staged.reduceRight<HivewarddMigrationStagedCatalog[]>((reversed, entry) => {
    reversed.push(entry)
    return reversed
  }, [])
}

function parseStagedCatalog(value: unknown): HivewarddMigrationStagedCatalog {
  if (!isRecord(value) || value.version !== HIVEWARDD_MIGRATION_MANIFEST_VERSION) {
    throw new Error('hivewardd_migration_staged_catalog_invalid')
  }
  const stagedAt = typeof value.stagedAt === 'string' ? value.stagedAt : ''
  if (!Number.isFinite(Date.parse(stagedAt))) {
    throw new Error('hivewardd_migration_staged_at_invalid')
  }
  return {
    version: HIVEWARDD_MIGRATION_MANIFEST_VERSION,
    manifest: parseHivewarddMigrationManifest(value.manifest),
    stagedAt
  }
}
