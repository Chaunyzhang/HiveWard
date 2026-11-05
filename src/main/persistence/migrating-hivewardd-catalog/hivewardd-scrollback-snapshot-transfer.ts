import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HivewarddMigrationManifest } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import {
  decodeHivewarddMigrationSnapshotChunk,
  type HivewarddMigrationSnapshotChunkRequest,
  type HivewarddMigrationSnapshotChunkResult,
  type HivewarddMigrationSnapshotUploadState,
  type HivewarddMigrationTerminalScrollbackSnapshot
} from '../../../shared/hivewardd-migration/hivewardd-migration-scrollback'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  getTerminalScrollbackSnapshotPath,
  getTerminalScrollbackSnapshotRoot,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import {
  appendHivewarddMigrationStagedChunk,
  ensureHivewarddMigrationDirectory,
  inspectHivewarddMigrationFinalFile,
  linkHivewarddMigrationStagedFile,
  hivewarddMigrationFileMatches,
  hivewarddMigrationStagedFileSize,
  hivewarddMigrationStagingDirectory,
  pruneHivewarddMigrationStagingDirectories,
  removeHivewarddMigrationStagingDirectory,
  requireStagedHivewarddMigrationManifest
} from './hivewardd-migration-staged-file'

/** Only the staged manifest's snapshots may receive chunks; retried ranges must match. */
export function stageHivewarddMigrationSnapshotChunk(args: {
  stagedManifest: HivewarddMigrationManifest | null
  storage: TerminalScrollbackSnapshotStorage
  request: HivewarddMigrationSnapshotChunkRequest
}): HivewarddMigrationSnapshotChunkResult {
  const manifest = requireStagedHivewarddMigrationManifest(
    args.stagedManifest,
    args.request,
    'hivewardd_migration_snapshot_catalog_not_staged'
  )
  const descriptor = requireDescriptor(manifest, args.request.ref)
  const bytes = decodeHivewarddMigrationSnapshotChunk(args.request.bytesBase64)
  ensureHivewarddMigrationDirectory(stagingDirectory(args.storage, manifest))
  const acknowledgedOffset = appendHivewarddMigrationStagedChunk({
    channel: 'snapshot',
    path: stagedSnapshotPath(args.storage, manifest, descriptor),
    offset: args.request.offset,
    bytes,
    byteLength: descriptor.byteLength
  })
  return {
    migrationId: args.request.migrationId,
    manifestSha256: args.request.manifestSha256,
    ref: args.request.ref,
    acknowledgedOffset
  }
}

export function inspectHivewarddMigrationSnapshotUploads(
  manifest: HivewarddMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): HivewarddMigrationSnapshotUploadState[] | undefined {
  const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  if (snapshots.length === 0) {
    return undefined
  }
  return snapshots.map((descriptor) => ({
    ...descriptor,
    receivedBytes:
      inspectFinalSnapshot(storage, descriptor) === 'matching'
        ? descriptor.byteLength
        : hivewarddMigrationStagedFileSize(
            stagedSnapshotPath(storage, manifest, descriptor),
            descriptor.byteLength
          )
  }))
}

export function assertHivewarddMigrationSnapshotsReady(
  manifest: HivewarddMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  for (const upload of inspectHivewarddMigrationSnapshotUploads(manifest, storage) ?? []) {
    const finalStatus = inspectFinalSnapshot(storage, upload)
    if (finalStatus === 'conflict') {
      throw new Error(`hivewardd_migration_snapshot_destination_conflict:${upload.ref}`)
    }
    if (upload.receivedBytes !== upload.byteLength) {
      throw new Error(`hivewardd_migration_snapshot_incomplete:${upload.ref}`)
    }
    const path =
      finalStatus === 'matching'
        ? getTerminalScrollbackSnapshotPath(upload.ref, storage)
        : stagedSnapshotPath(storage, manifest, upload)
    if (!path || !hivewarddMigrationFileMatches(path, upload)) {
      throw new Error(`hivewardd_migration_snapshot_digest_mismatch:${upload.ref}`)
    }
  }
}

export function commitHivewarddMigrationSnapshots(
  manifest: HivewarddMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  assertHivewarddMigrationSnapshotsReady(manifest, storage)
  const root = getTerminalScrollbackSnapshotRoot(storage)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const descriptor of snapshots) {
    const finalPath = getTerminalScrollbackSnapshotPath(descriptor.ref, storage)
    if (!finalPath) {
      throw new Error('hivewardd_migration_snapshot_ref_invalid')
    }
    linkHivewarddMigrationStagedFile({
      stagedPath: stagedSnapshotPath(storage, manifest, descriptor),
      finalPath,
      expected: descriptor,
      conflictError: `hivewardd_migration_snapshot_destination_conflict:${descriptor.ref}`
    })
  }
  syncDirectoryDurablySync(root)
  removeHivewarddMigrationStagingDirectory(root, manifest)
}

export function abortHivewarddMigrationSnapshots(
  manifest: HivewarddMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  removeHivewarddMigrationStagingDirectory(getTerminalScrollbackSnapshotRoot(storage), manifest)
}

export function pruneHivewarddMigrationSnapshotStaging(
  stagedManifests: readonly HivewarddMigrationManifest[],
  storage: TerminalScrollbackSnapshotStorage
): void {
  pruneHivewarddMigrationStagingDirectories(getTerminalScrollbackSnapshotRoot(storage), stagedManifests)
}

function requireDescriptor(
  manifest: HivewarddMigrationManifest,
  ref: string
): HivewarddMigrationTerminalScrollbackSnapshot {
  const descriptor = manifest.payload.dormantState?.terminalScrollbackSnapshots?.find(
    (entry) => entry.ref === ref
  )
  if (!descriptor) {
    throw new Error('hivewardd_migration_snapshot_unknown')
  }
  return descriptor
}

function inspectFinalSnapshot(
  storage: TerminalScrollbackSnapshotStorage,
  descriptor: HivewarddMigrationTerminalScrollbackSnapshot
): 'absent' | 'matching' | 'conflict' {
  return inspectHivewarddMigrationFinalFile(
    getTerminalScrollbackSnapshotPath(descriptor.ref, storage),
    descriptor
  )
}

function stagingDirectory(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: HivewarddMigrationManifest
): string {
  return hivewarddMigrationStagingDirectory(getTerminalScrollbackSnapshotRoot(storage), manifest)
}

function stagedSnapshotPath(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: HivewarddMigrationManifest,
  descriptor: HivewarddMigrationTerminalScrollbackSnapshot
): string {
  return join(stagingDirectory(storage, manifest), `${descriptor.ref}.${descriptor.sha256}.part`)
}
