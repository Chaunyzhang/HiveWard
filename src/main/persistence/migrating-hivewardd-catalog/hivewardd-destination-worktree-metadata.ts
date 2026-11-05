import type { PersistedState } from '../../../shared/persisted-state-types'
import type { HivewarddMigrationDormantStatePayload } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import { serializeHivewarddMigrationValue } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { omitDefaultWorktreeMetaFields } from '../../../shared/worktree/meta-persisted-defaults'

export function assertHivewarddDestinationCanonicalMetadata(
  state: PersistedState,
  entries: HivewarddMigrationDormantStatePayload['worktreeMeta']
): void {
  for (const { worktreeId, meta } of entries) {
    const alias = composeWorktreeHostIdentity('local', worktreeId)
    const identities = state.worktreeIdentityAliases?.[alias] ?? []
    const expectedKey = meta.instanceId
      ? canonicalWorktreeIdentity({
          worktreeId,
          executionHostId: 'local',
          instanceId: meta.instanceId
        })
      : undefined
    const candidates = new Set([
      ...identities,
      ...(expectedKey && state.worktreeMetaByIdentity?.[expectedKey] ? [expectedKey] : [])
    ])
    if (
      candidates.size > 1 ||
      [...candidates].some((key) => {
        const current = state.worktreeMetaByIdentity?.[key]
        return (
          !current ||
          key !== expectedKey ||
          serializeHivewarddMigrationValue(omitDefaultWorktreeMetaFields(current)) !==
            serializeHivewarddMigrationValue(omitDefaultWorktreeMetaFields(meta))
        )
      })
    ) {
      throw new Error(`hivewardd_migration_dormant_id_conflict:worktree_meta:${worktreeId}`)
    }
  }
}
