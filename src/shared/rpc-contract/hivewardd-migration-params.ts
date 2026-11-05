import { z } from 'zod'
import {
  MAX_HIVEWARDD_MIGRATION_BLOBS,
  HivewarddMigrationBlobDescriptorSchema
} from '../hivewardd-migration/hivewardd-migration-blob-transfer'

// Let the handler parse/digest-check the manifest so malformed input receives a migration-specific refusal.
export const HivewarddMigrationCatalogParams = z.object({ manifest: z.unknown() })

// Optional: sent only to a blob-channel destination, so SSH and older peers see `{ manifest }`.
export const HivewarddMigrationCommitCatalogParams = HivewarddMigrationCatalogParams.extend({
  expectedBlobs: z
    .array(HivewarddMigrationBlobDescriptorSchema)
    .max(MAX_HIVEWARDD_MIGRATION_BLOBS)
    .optional()
})

// The manifest's identity alone, for a request the whole manifest would overflow.
export const HivewarddMigrationCatalogReferenceParams = z.object({
  migrationId: z.string().min(1).max(256),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/)
})
