// Export copies of relay-hosted SSH state without mutating source rows.
import {
  HIVEWARDD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
  type HivewarddMigrationTerminalScrollbackSnapshot
} from '../../../shared/hivewardd-migration/hivewardd-migration-scrollback'
import type {
  HivewarddMigrationCatalogPayload,
  HivewarddMigrationDormantStatePayload,
  HivewarddMigrationManifest,
  HivewarddMigrationManifestSource
} from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import { assertHivewarddMigrationManifestDigest } from '../../hivewardd/hivewardd-migration-manifest-digest'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  collectHivewarddMigrationUntransferredDependencyCensus,
  type HivewarddMigrationSourceDependencyCensus
} from './hivewardd-source-dependency-census'
import {
  collectHivewarddMigrationSourceDormantState,
  type HivewarddMigrationSourceDormantInspection
} from './hivewardd-source-dormant-state'
import { readHivewarddMigrationSourceScrollbackChunk } from './hivewardd-source-scrollback-state'
import {
  createHivewarddMigrationDeltaView,
  type HivewarddMigrationDeltaView
} from './hivewardd-source-delta-view'
import { syncHivewarddMigrationScrollbackRetention } from './hivewardd-source-scrollback-retention'
import { createHivewarddMigrationLeaveBehindView } from './hivewardd-source-leave-behind-view'
import {
  collectHivewarddMigrationSourceDrafts,
  type HivewarddMigrationSourceDrafts
} from './hivewardd-source-draft-rename'

type HivewarddSourceExportRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage' | 'retainedScrollbackRefsByMigrationId'
>

const hivewarddSourceExportContext = Symbol('HivewarddSourceExportPersistence')

export class HivewarddSourceExportPersistence {
  readonly [hivewarddSourceExportContext]: HivewarddSourceExportRuntime

  constructor(runtime: HivewarddSourceExportRuntime) {
    this[hivewarddSourceExportContext] = runtime
  }

  collectHivewarddMigrationSourceDormantState(
    source: HivewarddMigrationManifestSource,
    catalog: HivewarddMigrationCatalogPayload,
    destinationEnvironmentId?: string
  ): HivewarddMigrationDormantStatePayload {
    const runtime = this[hivewarddSourceExportContext]
    return collectHivewarddMigrationSourceDormantState(
      runtime.state,
      source,
      catalog,
      runtime.terminalScrollbackSnapshotStorage,
      destinationEnvironmentId
    ).payload
  }

  /** The export plus what it could not carry, for a move that must refuse rather than drop rows. */
  inspectHivewarddMigrationSourceDormantState(
    source: HivewarddMigrationManifestSource,
    catalog: HivewarddMigrationCatalogPayload,
    destinationEnvironmentId?: string,
    daemonHistoryLeaf?: (tabId: string, leafId: string) => boolean
  ): HivewarddMigrationSourceDormantInspection {
    const runtime = this[hivewarddSourceExportContext]
    return collectHivewarddMigrationSourceDormantState(
      runtime.state,
      source,
      catalog,
      runtime.terminalScrollbackSnapshotStorage,
      destinationEnvironmentId,
      daemonHistoryLeaf
    )
  }

  collectHivewarddMigrationSourceDrafts(manifest: HivewarddMigrationManifest): HivewarddMigrationSourceDrafts {
    return collectHivewarddMigrationSourceDrafts(this[hivewarddSourceExportContext].state, manifest)
  }

  createHivewarddMigrationDeltaView(moved: HivewarddMigrationManifest): HivewarddMigrationDeltaView {
    return createHivewarddMigrationDeltaView(this[hivewarddSourceExportContext], moved)
  }

  /** Preview "Move anyway" without recording consent. */
  createHivewarddMigrationLeaveBehindView(targetId: string): HivewarddMigrationDeltaView {
    return createHivewarddMigrationLeaveBehindView(this[hivewarddSourceExportContext], targetId)
  }

  inspectHivewarddMigrationUntransferredDependencies(
    manifest: HivewarddMigrationManifest
  ): HivewarddMigrationSourceDependencyCensus {
    const runtime = this[hivewarddSourceExportContext]
    return collectHivewarddMigrationUntransferredDependencyCensus(
      runtime.state,
      manifest,
      runtime.terminalScrollbackSnapshotStorage
    )
  }

  /** Retain unfinished migrations' snapshots even if their tabs close. */
  syncHivewarddMigrationScrollbackRetention(pending: readonly HivewarddMigrationManifest[]): void {
    syncHivewarddMigrationScrollbackRetention(this[hivewarddSourceExportContext], pending)
  }

  /** Verify snapshot bytes against the signed manifest so changed buffers cannot be transferred. */
  readHivewarddMigrationSourceSnapshotChunk(
    manifest: HivewarddMigrationManifest,
    ref: string,
    offset: number
  ): { bytesBase64: string; totalBytes: number; eof: boolean } {
    assertHivewarddMigrationManifestDigest(manifest)
    const descriptor: HivewarddMigrationTerminalScrollbackSnapshot | undefined =
      manifest.payload.dormantState?.terminalScrollbackSnapshots?.find((entry) => entry.ref === ref)
    if (!descriptor) {
      throw new Error('hivewardd_migration_source_snapshot_unknown')
    }
    const runtime = this[hivewarddSourceExportContext]
    return readHivewarddMigrationSourceScrollbackChunk({
      state: runtime.state,
      descriptor,
      retained: [...runtime.retainedScrollbackRefsByMigrationId.values()].some((refs) =>
        refs.has(ref)
      ),
      offset,
      length: HIVEWARDD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
      storage: runtime.terminalScrollbackSnapshotStorage
    })
  }
}
