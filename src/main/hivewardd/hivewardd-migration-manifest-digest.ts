import { createHash } from 'node:crypto'
import {
  hivewarddMigrationManifestHashInput,
  serializeHivewarddMigrationValue,
  type HivewarddMigrationManifest
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'

export function computeHivewarddMigrationManifestSha256(
  manifest: Omit<HivewarddMigrationManifest, 'manifestSha256'>
): string {
  return createHash('sha256').update(hivewarddMigrationManifestHashInput(manifest)).digest('hex')
}

/** Hash the received manifest: unknown fields from newer peers are part of its signature. */
export function assertHivewarddMigrationManifestDigest(manifest: unknown): void {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('hivewardd_migration_manifest_invalid')
  }
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'manifestSha256')
  )
  const digest = createHash('sha256').update(serializeHivewarddMigrationValue(unsigned)).digest('hex')
  if (!('manifestSha256' in manifest) || digest !== manifest.manifestSha256) {
    throw new Error('hivewardd_migration_manifest_digest_mismatch')
  }
}
