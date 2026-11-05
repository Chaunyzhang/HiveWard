import type { PersistedState } from '../../../shared/persisted-state-types'
import type { PersistedTrustedHiveWardHooks } from '../../../shared/hiveward-yaml-hook-types'
import type {
  HivewarddMigrationImportReceipt,
  HivewarddMigrationStagedCatalog
} from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { HivewarddMigrationEvictedReceipt } from '../../../shared/hivewardd-migration/hivewardd-migration-evicted-receipts'

type LegacyProfileDomains = {
  orcadMigrationImportReceipts?: HivewarddMigrationImportReceipt[]
  orcadMigrationEvictedReceipts?: HivewarddMigrationEvictedReceipt[]
  orcadMigrationStagedCatalogs?: HivewarddMigrationStagedCatalog[]
}

type UiWithLegacyTrust = PersistedState['ui'] & {
  trustedOrcaHooks?: PersistedTrustedHiveWardHooks
}

/** Pre-rename Orca daemon receipts stay in the domain the current reader asks for. */
export function migrateLegacyOrcaProfileDomains(
  parsed: PersistedState,
  markNeedsSave: () => void
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: LegacyProfileDomains extends the persisted shape with the old keys this one-time migration removes.
  const domains = parsed as PersistedState & LegacyProfileDomains
  const importReceipts = domains.orcadMigrationImportReceipts
  const evictedReceipts = domains.orcadMigrationEvictedReceipts
  const stagedCatalogs = domains.orcadMigrationStagedCatalogs
  if (importReceipts !== undefined) {
    delete domains.orcadMigrationImportReceipts
    domains.hivewarddMigrationImportReceipts = [
      ...importReceipts,
      ...(domains.hivewarddMigrationImportReceipts ?? [])
    ]
    markNeedsSave()
  }
  if (evictedReceipts !== undefined) {
    delete domains.orcadMigrationEvictedReceipts
    domains.hivewarddMigrationEvictedReceipts = [
      ...evictedReceipts,
      ...(domains.hivewarddMigrationEvictedReceipts ?? [])
    ]
    markNeedsSave()
  }
  if (stagedCatalogs !== undefined) {
    delete domains.orcadMigrationStagedCatalogs
    domains.hivewarddMigrationStagedCatalogs = [
      ...stagedCatalogs,
      ...(domains.hivewarddMigrationStagedCatalogs ?? [])
    ]
    markNeedsSave()
  }
}

/** The hook-trust map was renamed with the product; keep approvals users already granted. */
export function migrateLegacyOrcaTrustedHooks(
  ui: PersistedState['ui'],
  markNeedsSave: () => void
): PersistedState['ui'] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The old hook-trust key exists only on databases written before the rename.
  const legacyUi = ui as UiWithLegacyTrust
  if (ui === undefined || legacyUi.trustedOrcaHooks === undefined) {
    return ui
  }
  const { trustedOrcaHooks, ...current } = legacyUi
  markNeedsSave()
  return {
    ...current,
    trustedHiveWardHooks: current.trustedHiveWardHooks ?? trustedOrcaHooks
  }
}
