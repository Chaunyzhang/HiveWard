import { vi, type Mock } from 'vitest'
import type {
  HivewarddMigrationCatalogState,
  HivewarddMigrationManifest
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { HivewarddMigrationDestinationCatalog } from './hivewardd-migration-cutover-coordinator'

type Catalog = HivewarddMigrationDestinationCatalog

export type FakeHivewarddMigrationDestination = { commits: number } & {
  [Method in keyof Catalog]: Mock<Catalog[Method]>
}

/** Model idempotent stage and receipt-keyed commit with separate catalog state for each migration, including later deltas. */
export function fakeHivewarddMigrationDestination(): FakeHivewarddMigrationDestination {
  const states = new Map<string, 'absent' | 'staged' | 'committed'>()
  const stateOf = (manifest: Pick<HivewarddMigrationManifest, 'migrationId'>) =>
    states.get(manifest.migrationId) ?? 'absent'
  const view = (manifest: HivewarddMigrationManifest): HivewarddMigrationCatalogState => {
    const state = stateOf(manifest)
    const base = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
    if (state === 'committed') {
      return {
        ...base,
        state,
        receipt: {
          version: 1,
          migrationId: manifest.migrationId,
          manifestSha256: manifest.manifestSha256,
          source: manifest.source,
          importedAt: '2026-10-01T00:00:00.000Z',
          repositoryIds: [],
          projectGroupIds: [],
          folderWorkspaceIds: []
        }
      }
    }
    return state === 'staged'
      ? { ...base, state, stagedAt: '2026-10-01T00:00:00.000Z', snapshotUploads: [] }
      : { ...base, state }
  }
  const destination: FakeHivewarddMigrationDestination = {
    commits: 0,
    readState: vi.fn<Catalog['readState']>(async (manifest: HivewarddMigrationManifest) =>
      view(manifest)
    ),
    stage: vi.fn<Catalog['stage']>(async (manifest: HivewarddMigrationManifest) => {
      if (stateOf(manifest) === 'absent') {
        states.set(manifest.migrationId, 'staged')
      }
      return view(manifest)
    }),
    commit: vi.fn<Catalog['commit']>(async (manifest: HivewarddMigrationManifest) => {
      if (stateOf(manifest) === 'staged') {
        states.set(manifest.migrationId, 'committed')
        destination.commits += 1
      }
      return view(manifest)
    }),
    abort: vi.fn<Catalog['abort']>(async (manifest: HivewarddMigrationManifest) => {
      const aborted = stateOf(manifest) === 'staged'
      if (aborted) {
        states.set(manifest.migrationId, 'absent')
      }
      return { ...view(manifest), aborted, ...(aborted ? {} : { durableAbsent: true as const }) }
    }),
    abortByReference: vi.fn<Catalog['abortByReference']>(async (manifest) => {
      const identity = {
        migrationId: manifest.migrationId,
        manifestSha256: manifest.manifestSha256
      }
      if (stateOf(manifest) === 'committed') {
        return { ...identity, state: 'committed', aborted: false }
      }
      const aborted = stateOf(manifest) === 'staged'
      states.delete(manifest.migrationId)
      return { ...identity, state: 'absent', aborted, durableAbsent: true }
    }),
    stageChunk: vi.fn<Catalog['stageChunk']>()
  }
  return destination
}
