import { MAX_HIVEWARDD_MIGRATION_STAGED_CATALOGS } from '../../../shared/hivewardd-migration/hivewardd-migration-staged-catalog-validation'
import { HIVEWARDD_MIGRATION_MANIFEST_VERSION } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest-validation'
import type {
  HivewarddMigrationCatalogAbortResult,
  HivewarddMigrationCatalogReference,
  HivewarddMigrationCatalogReferenceAbortResult,
  HivewarddMigrationCatalogState,
  HivewarddMigrationImportReceipt,
  HivewarddMigrationManifest
} from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type {
  HivewarddMigrationSnapshotChunkRequest,
  HivewarddMigrationSnapshotChunkResult
} from '../../../shared/hivewardd-migration/hivewardd-migration-scrollback'
import type {
  HivewarddMigrationBlobChunkRequest,
  HivewarddMigrationBlobChunkResult,
  HivewarddMigrationBlobDescriptor
} from '../../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import type { RepoLifecycleOperations } from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../loading-store/write-scheduling'
import { scheduleSave } from '../loading-store/write-scheduling'
import {
  applyPreparedHivewarddMigrationCatalog,
  assertHivewarddMigrationReceiptMatchesManifest,
  assertSameHivewarddMigrationManifest,
  prepareHivewarddMigrationCatalog,
  type PreparedHivewarddMigrationCatalog
} from './hivewardd-catalog-records'
import {
  expireHivewarddMigrationStages,
  findHivewarddMigrationImportReceipt,
  isLiveHivewarddMigrationStage,
  recordHivewarddMigrationCommitWriteGeneration,
  recordHivewarddMigrationImportReceipt,
  type HivewarddMigrationCommitGenerationRuntime
} from './hivewardd-catalog-receipt-ledger'
import {
  abortHivewarddMigrationSnapshots,
  assertHivewarddMigrationSnapshotsReady,
  commitHivewarddMigrationSnapshots,
  inspectHivewarddMigrationSnapshotUploads,
  pruneHivewarddMigrationSnapshotStaging,
  stageHivewarddMigrationSnapshotChunk
} from './hivewardd-scrollback-snapshot-transfer'
import {
  abortHivewarddMigrationBlobs,
  assertHivewarddMigrationBlobSetMatches,
  assertHivewarddMigrationBlobsReady,
  commitHivewarddMigrationBlobs,
  inspectHivewarddMigrationBlobUploads,
  pruneHivewarddMigrationBlobStaging,
  stageHivewarddMigrationBlobChunk
} from './hivewardd-migration-blob-staging'
import { assertHivewarddMigrationBlobContentsValid } from './hivewardd-migration-blob-installers'
import {
  abortHivewarddMigrationCatalogByReference,
  committedMigrations,
  stagedManifests
} from './hivewardd-catalog-reference-abort'

type HivewarddCatalogImportRuntime = HivewarddMigrationCommitGenerationRuntime &
  Pick<StoreRuntimeState, 'state' | 'terminalScrollbackSnapshotStorage' | 'hivewarddMigrationBlobRoot'>

const hivewarddCatalogImportContext = Symbol('HivewarddCatalogImportPersistence')
type HivewarddCatalogImportContext = {
  runtime: HivewarddCatalogImportRuntime
  repos: RepoLifecycleOperations
  scheduling: WriteSchedulingOperations
}

// Manifests arrive parsed; the RPC boundary verified the digest over the bytes as sent.
export class HivewarddCatalogImportPersistence {
  readonly [hivewarddCatalogImportContext]: HivewarddCatalogImportContext

  constructor(
    runtime: HivewarddCatalogImportRuntime,
    repos: RepoLifecycleOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[hivewarddCatalogImportContext] = { runtime, repos, scheduling }
  }

  stageHivewarddMigrationCatalog(
    manifest: HivewarddMigrationManifest,
    options: { now?: () => Date } = {}
  ): HivewarddMigrationCatalogState {
    const context = this[hivewarddCatalogImportContext]
    const now = options.now ?? (() => new Date())
    if (expireHivewarddMigrationStages(context.runtime.state, now().getTime())) {
      scheduleSave(context.scheduling)
    }
    pruneHivewarddMigrationSnapshotStaging(
      stagedManifests(context.runtime.state),
      context.runtime.terminalScrollbackSnapshotStorage
    )
    pruneHivewarddMigrationBlobStaging(
      stagedManifests(context.runtime.state),
      committedMigrations(context.runtime.state),
      context.runtime.hivewarddMigrationBlobRoot
    )
    const current = migrationCatalogState(context.runtime, manifest)
    if (current.state === 'committed') {
      return current
    }
    prepareHivewarddMigrationCatalog(manifest, context.runtime.state)
    if (current.state === 'staged') {
      return current
    }
    const staged = context.runtime.state.hivewarddMigrationStagedCatalogs ?? []
    if (staged.length >= MAX_HIVEWARDD_MIGRATION_STAGED_CATALOGS) {
      throw new Error('hivewardd_migration_staging_capacity_exceeded')
    }
    const stagedAt = now().toISOString()
    context.runtime.state.hivewarddMigrationStagedCatalogs = [
      ...staged,
      {
        version: HIVEWARDD_MIGRATION_MANIFEST_VERSION,
        manifest: structuredClone(manifest),
        stagedAt
      }
    ]
    scheduleSave(context.scheduling)
    return stagedCatalogState(manifest, stagedAt, context.runtime)
  }

  stageHivewarddMigrationSnapshotChunk(
    request: HivewarddMigrationSnapshotChunkRequest
  ): HivewarddMigrationSnapshotChunkResult {
    const context = this[hivewarddCatalogImportContext]
    return stageHivewarddMigrationSnapshotChunk({
      stagedManifest:
        stagedManifests(context.runtime.state).find(
          (manifest) => manifest.migrationId === request.migrationId
        ) ?? null,
      storage: context.runtime.terminalScrollbackSnapshotStorage,
      request
    })
  }

  stageHivewarddMigrationBlobChunk(
    request: HivewarddMigrationBlobChunkRequest
  ): HivewarddMigrationBlobChunkResult {
    const context = this[hivewarddCatalogImportContext]
    return stageHivewarddMigrationBlobChunk({
      stagedManifest:
        stagedManifests(context.runtime.state).find(
          (manifest) => manifest.migrationId === request.migrationId
        ) ?? null,
      root: context.runtime.hivewarddMigrationBlobRoot,
      request
    })
  }

  /** Omitted expectedBlobs preserves older senders' commit behavior. */
  commitStagedHivewarddMigrationCatalog(
    manifest: HivewarddMigrationManifest,
    options: { now?: () => Date; expectedBlobs?: readonly HivewarddMigrationBlobDescriptor[] } = {}
  ): HivewarddMigrationCatalogState {
    const context = this[hivewarddCatalogImportContext]
    const current = migrationCatalogState(context.runtime, manifest)
    if (current.state === 'committed') {
      return current
    }
    if (current.state !== 'staged') {
      throw new Error('hivewardd_migration_catalog_not_staged')
    }
    const prepared = prepareHivewarddMigrationCatalog(manifest, context.runtime.state)
    const blobRoot = context.runtime.hivewarddMigrationBlobRoot
    assertHivewarddMigrationSnapshotsReady(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    if (options.expectedBlobs) {
      assertHivewarddMigrationBlobSetMatches(manifest, blobRoot, options.expectedBlobs)
    }
    assertHivewarddMigrationBlobsReady(manifest, blobRoot)
    assertHivewarddMigrationBlobContentsValid(manifest, blobRoot)
    commitHivewarddMigrationSnapshots(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    commitHivewarddMigrationBlobs(manifest, blobRoot)
    const receipt = commitPreparedCatalog(context, manifest, prepared, options.now)
    const generationBefore = context.runtime.writeGeneration
    scheduleSave(context.scheduling)
    recordHivewarddMigrationCommitWriteGeneration(context.runtime, manifest, generationBefore)
    return committedCatalogState(receipt)
  }

  abortStagedHivewarddMigrationCatalog(
    manifest: HivewarddMigrationManifest
  ): HivewarddMigrationCatalogAbortResult {
    const context = this[hivewarddCatalogImportContext]
    const current = migrationCatalogState(context.runtime, manifest)
    if (current.state === 'committed' || current.state === 'absent') {
      return { ...current, aborted: false }
    }
    // Staged rows are dormant and unreferenced outside this stage.
    context.runtime.state.hivewarddMigrationStagedCatalogs = (
      context.runtime.state.hivewarddMigrationStagedCatalogs ?? []
    ).filter((entry) => entry.manifest.migrationId !== manifest.migrationId)
    abortHivewarddMigrationSnapshots(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    abortHivewarddMigrationBlobs(manifest, context.runtime.hivewarddMigrationBlobRoot)
    scheduleSave(context.scheduling)
    return { ...absentCatalogState(manifest), aborted: true }
  }

  /** Use the stored manifest when the source cannot send one. */
  abortStagedHivewarddMigrationCatalogByReference(
    reference: HivewarddMigrationCatalogReference
  ): HivewarddMigrationCatalogReferenceAbortResult {
    return abortHivewarddMigrationCatalogByReference(
      this[hivewarddCatalogImportContext].runtime.state,
      reference,
      (manifest) => this.abortStagedHivewarddMigrationCatalog(manifest)
    )
  }

  getHivewarddMigrationCatalogState(manifest: HivewarddMigrationManifest): HivewarddMigrationCatalogState {
    const context = this[hivewarddCatalogImportContext]
    return migrationCatalogState(context.runtime, manifest)
  }

  hasStagedHivewarddMigrationCatalog(now: number = Date.now()): boolean {
    return (this[hivewarddCatalogImportContext].runtime.state.hivewarddMigrationStagedCatalogs ?? []).some(
      (entry) => isLiveHivewarddMigrationStage(entry.stagedAt, now)
    )
  }
}

function commitPreparedCatalog(
  context: HivewarddCatalogImportContext,
  manifest: HivewarddMigrationManifest,
  prepared: PreparedHivewarddMigrationCatalog,
  now?: () => Date
): HivewarddMigrationImportReceipt {
  applyPreparedHivewarddMigrationCatalog(prepared, context.runtime.state, context.repos)
  const receipt: HivewarddMigrationImportReceipt = {
    version: HIVEWARDD_MIGRATION_MANIFEST_VERSION,
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    source: structuredClone(manifest.source),
    importedAt: (now ?? (() => new Date()))().toISOString(),
    repositoryIds: prepared.repositories.map((repo) => repo.id),
    projectGroupIds: prepared.projectGroups.map((group) => group.id),
    folderWorkspaceIds: prepared.folderWorkspaces.map((workspace) => workspace.id)
  }
  context.runtime.state.hivewarddMigrationStagedCatalogs = (
    context.runtime.state.hivewarddMigrationStagedCatalogs ?? []
  ).filter((entry) => entry.manifest.migrationId !== manifest.migrationId)
  recordHivewarddMigrationImportReceipt(context.runtime.state, receipt)
  return receipt
}

function migrationCatalogState(
  runtime: HivewarddCatalogImportRuntime,
  manifest: HivewarddMigrationManifest
): HivewarddMigrationCatalogState {
  const { state } = runtime
  const receipt = findHivewarddMigrationImportReceipt(state, manifest)
  if (receipt) {
    assertCommittedReceipt(receipt, manifest)
    return committedCatalogState(receipt)
  }
  const staged = state.hivewarddMigrationStagedCatalogs?.find(
    (entry) => entry.manifest.migrationId === manifest.migrationId
  )
  if (!staged) {
    return absentCatalogState(manifest)
  }
  assertSameHivewarddMigrationManifest(staged.manifest, manifest)
  return stagedCatalogState(manifest, staged.stagedAt, runtime)
}

// A committed receipt stays authoritative even after live rows and snapshots change.
function assertCommittedReceipt(
  receipt: HivewarddMigrationImportReceipt,
  manifest: HivewarddMigrationManifest
): void {
  if (receipt.manifestSha256 !== manifest.manifestSha256) {
    throw new Error('hivewardd_migration_id_reused_with_different_manifest')
  }
  assertHivewarddMigrationReceiptMatchesManifest(receipt, manifest)
}

function absentCatalogState(manifest: HivewarddMigrationManifest): HivewarddMigrationCatalogState {
  return {
    state: 'absent',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256
  }
}

function stagedCatalogState(
  manifest: HivewarddMigrationManifest,
  stagedAt: string,
  runtime: HivewarddCatalogImportRuntime
): HivewarddMigrationCatalogState {
  const snapshotUploads = inspectHivewarddMigrationSnapshotUploads(
    manifest,
    runtime.terminalScrollbackSnapshotStorage
  )
  // Omit absent uploads to preserve older hosts' response shape.
  const blobUploads = inspectHivewarddMigrationBlobUploads(manifest, runtime.hivewarddMigrationBlobRoot)
  return {
    state: 'staged',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    stagedAt,
    ...(snapshotUploads ? { snapshotUploads } : {}),
    ...(blobUploads ? { blobUploads } : {})
  }
}

function committedCatalogState(receipt: HivewarddMigrationImportReceipt): HivewarddMigrationCatalogState {
  return {
    state: 'committed',
    migrationId: receipt.migrationId,
    manifestSha256: receipt.manifestSha256,
    receipt: structuredClone(receipt)
  }
}
