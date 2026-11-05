import type { HivewarddMigrationCatalogState } from '../../shared/hivewardd-migration/hivewardd-migration-manifest'

export async function resolveDurableHivewarddCatalogMutation(
  mutate: () => Promise<HivewarddMigrationCatalogState>,
  read: () => Promise<HivewarddMigrationCatalogState>,
  accepted: (state: HivewarddMigrationCatalogState) => boolean
) {
  try {
    return await mutate()
  } catch (mutationError) {
    let observed: HivewarddMigrationCatalogState
    try {
      observed = await read()
    } catch {
      throw mutationError
    }
    if (!accepted(observed)) {
      throw mutationError
    }
  }
  // State reads may reflect unflushed mutations; an idempotent acknowledgment proves durability.
  return mutate()
}
