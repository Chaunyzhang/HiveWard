import { parseHivewarddMigrationCatalogReferenceAbortResult } from '../../shared/hivewardd-migration/hivewardd-migration-catalog-state'
import type {
  HivewarddMigrationCatalogReference,
  HivewarddMigrationCatalogReferenceAbortResult
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import { HIVEWARDD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY } from '../../shared/hivewardd-runtime-capabilities'
import { parsePairingCode } from '../../shared/pairing'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  HIVEWARDD_MIGRATION_DESTINATION_UNSUPPORTED,
  sendSupportedMigrationRequest,
  type CatalogRequestOptions
} from './hivewardd-migration-catalog-client'

/** Unlike migration-unsupported, this refusal cannot prove no earlier stage exists. */
export const HIVEWARDD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED =
  'hivewardd_migration_destination_abort_by_reference_unsupported:Update HiveWard on this host to cancel this move.'

/** Abort by manifest identity when the full request cannot fit the sealed frame. */
export async function abortRemoteHivewarddMigrationCatalogByReference(
  pairingCode: string,
  manifest: HivewarddMigrationCatalogReference,
  options: CatalogRequestOptions = {}
): Promise<HivewarddMigrationCatalogReferenceAbortResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('hivewardd_migration_pairing_code_invalid')
  }
  let supportsReference = false
  let response: RuntimeRpcResponse<unknown>
  try {
    response = await sendSupportedMigrationRequest(
      pairing,
      'hivewardd.migration.abortCatalogByReference',
      { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 },
      options,
      false,
      null,
      (capabilities) => {
        supportsReference = capabilities.includes(
          HIVEWARDD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY
        )
        if (!supportsReference) {
          throw new Error(HIVEWARDD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED)
        }
      }
    )
  } catch (error) {
    // A missing method on a host that advertised it proves nothing about what it staged.
    if (
      supportsReference &&
      error instanceof Error &&
      error.message === HIVEWARDD_MIGRATION_DESTINATION_UNSUPPORTED
    ) {
      throw new Error(HIVEWARDD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED)
    }
    throw error
  }
  if (!response.ok) {
    throw new Error(`hivewardd_migration_abort_failed:${response.error.message}`)
  }
  return parseHivewarddMigrationCatalogReferenceAbortResult(response.result, manifest)
}
