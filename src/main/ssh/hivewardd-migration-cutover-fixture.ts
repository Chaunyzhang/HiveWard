import { HIVEWARDD_MIGRATION_MANIFEST_VERSION } from '../../shared/hivewardd-migration/hivewardd-migration-manifest-validation'
import type { HivewarddMigrationSourceCutover } from '../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import { computeHivewarddMigrationManifestSha256 } from '../hivewardd/hivewardd-migration-manifest-digest'

export function hivewarddMigrationCutoverFixture(
  migrationId = 'migration-1',
  sshTargetId = 'ssh-1',
  binding: { generation?: number; environmentId?: string; name?: string } = {}
): HivewarddMigrationSourceCutover {
  const generation = binding.generation ?? 2
  const environmentId = binding.environmentId ?? 'env-1'
  const unsigned = {
    version: HIVEWARDD_MIGRATION_MANIFEST_VERSION,
    migrationId,
    createdAt: '2026-10-01T00:00:00.000Z',
    source: { sshTargetId, sshTargetGeneration: generation, targetLabel: 'Prod' },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
    destinationEnvironmentId: environmentId
  }
  const manifest = { ...unsigned, manifestSha256: computeHivewarddMigrationManifestSha256(unsigned) }
  return {
    version: 1,
    migrationId,
    phase: 'source-fenced',
    startedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    destinationEnvironmentId: environmentId,
    destinationName: binding.name ?? 'Managed',
    sshTargetId,
    sshTargetGeneration: generation,
    manifestSha256: manifest.manifestSha256,
    provenPtyIds: [],
    manifest
  }
}
