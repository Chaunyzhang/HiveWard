// The manifest omits blobs; descriptor filenames make staged uploads resumable after restart.
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  HIVEWARDD_MIGRATION_BLOB_KINDS,
  assertHivewarddMigrationBlobSet,
  decodeHivewarddMigrationBlobChunk,
  hivewarddMigrationBlobIdentity,
  parseHivewarddMigrationBlobDescriptor,
  sameHivewarddMigrationBlob,
  type HivewarddMigrationBlobChunkRequest,
  type HivewarddMigrationBlobChunkResult,
  type HivewarddMigrationBlobDescriptor,
  type HivewarddMigrationBlobKind,
  type HivewarddMigrationBlobUploadState
} from '../../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import type { HivewarddMigrationManifest } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  appendHivewarddMigrationStagedChunk,
  ensureHivewarddMigrationDirectory,
  inspectHivewarddMigrationFinalFile,
  linkHivewarddMigrationStagedFile,
  hivewarddMigrationFileMatches,
  hivewarddMigrationStagedFileSize,
  hivewarddMigrationStagingDirectory,
  hivewarddMigrationStagingKey,
  pruneHivewarddMigrationKeyedDirectories,
  pruneHivewarddMigrationStagingDirectories,
  removeHivewarddMigrationStagingDirectory,
  requireStagedHivewarddMigrationManifest,
  type HivewarddMigrationRequestIdentity
} from './hivewardd-migration-staged-file'

const RECEIVED_DIRECTORY = 'received'
const STAGED_BLOB_NAME = /^([^.]+)\.([a-f0-9]{64})\.([1-9][0-9]*)\.part$/

type HivewarddMigrationBlobName = Pick<HivewarddMigrationBlobDescriptor, 'blobKind' | 'key'>

type ReceivedBlobPathResolver = (
  root: string,
  manifest: HivewarddMigrationRequestIdentity,
  descriptor: HivewarddMigrationBlobName
) => string

const receivedDirectoryPath: ReceivedBlobPathResolver = (root, manifest, descriptor) =>
  join(receivedBlobsDirectory(root, manifest), descriptor.blobKind, descriptor.key)

const RECEIVED_BLOB_DESTINATIONS: Record<HivewarddMigrationBlobKind, ReceivedBlobPathResolver> = {
  'terminal-restore-hints': receivedDirectoryPath,
  'shell-history': receivedDirectoryPath,
  'agent-session-records': receivedDirectoryPath,
  'terminal-history': receivedDirectoryPath
}

export function getHivewarddMigrationReceivedBlobPath(
  root: string,
  manifest: HivewarddMigrationRequestIdentity,
  descriptor: HivewarddMigrationBlobName
): string {
  return RECEIVED_BLOB_DESTINATIONS[descriptor.blobKind](root, manifest, descriptor)
}

export function listHivewarddMigrationReceivedBlobNames(
  root: string,
  manifest: HivewarddMigrationRequestIdentity,
  blobKind: HivewarddMigrationBlobKind
): string[] {
  return readDirectory(join(receivedBlobsDirectory(root, manifest), blobKind))
}

export type HivewarddMigrationBlobChunkStaging = {
  stagedManifest: HivewarddMigrationManifest | null
  root: string
  request: HivewarddMigrationBlobChunkRequest
}

export function stageHivewarddMigrationBlobChunk(
  args: HivewarddMigrationBlobChunkStaging
): HivewarddMigrationBlobChunkResult {
  const manifest = requireStagedHivewarddMigrationManifest(
    args.stagedManifest,
    args.request,
    'hivewardd_migration_blob_catalog_not_staged'
  )
  const descriptor = parseHivewarddMigrationBlobDescriptor(args.request.blob)
  const bytes = decodeHivewarddMigrationBlobChunk(args.request.bytesBase64)
  const staged = stagedBlobDescriptors(args.root, manifest)
  const existing = staged.find(
    (entry) => hivewarddMigrationBlobIdentity(entry) === hivewarddMigrationBlobIdentity(descriptor)
  )
  if (existing && !sameHivewarddMigrationBlob(existing, descriptor)) {
    // Replacing staged bytes requires abort and restage.
    throw new Error(`hivewardd_migration_blob_descriptor_conflict:${descriptor.blobKind}`)
  }
  if (!existing) {
    assertHivewarddMigrationBlobSet([...staged, descriptor])
  }
  const path = stagedBlobPath(args.root, manifest, descriptor)
  ensureHivewarddMigrationDirectory(dirname(path))
  const receivedBytes = appendHivewarddMigrationStagedChunk({
    channel: 'blob',
    path,
    offset: args.request.offset,
    bytes,
    byteLength: descriptor.byteLength
  })
  return {
    migrationId: args.request.migrationId,
    manifestSha256: args.request.manifestSha256,
    blobKind: descriptor.blobKind,
    key: descriptor.key,
    receivedBytes
  }
}

export function inspectHivewarddMigrationBlobUploads(
  manifest: HivewarddMigrationManifest,
  root: string
): HivewarddMigrationBlobUploadState[] | undefined {
  const uploads = stagedBlobDescriptors(root, manifest).map((descriptor) => ({
    ...descriptor,
    receivedBytes:
      inspectReceivedBlob(root, manifest, descriptor) === 'matching'
        ? descriptor.byteLength
        : hivewarddMigrationStagedFileSize(
            stagedBlobPath(root, manifest, descriptor),
            descriptor.byteLength
          )
  }))
  return uploads.length > 0 ? uploads : undefined
}

export function assertHivewarddMigrationBlobsReady(
  manifest: HivewarddMigrationManifest,
  root: string
): void {
  for (const upload of inspectHivewarddMigrationBlobUploads(manifest, root) ?? []) {
    const label = `${upload.blobKind}:${upload.key}`
    const finalStatus = inspectReceivedBlob(root, manifest, upload)
    if (finalStatus === 'conflict') {
      throw new Error(`hivewardd_migration_blob_destination_conflict:${label}`)
    }
    if (upload.receivedBytes !== upload.byteLength) {
      throw new Error(`hivewardd_migration_blob_incomplete:${label}`)
    }
    if (
      finalStatus !== 'matching' &&
      !hivewarddMigrationFileMatches(stagedBlobPath(root, manifest, upload), upload)
    ) {
      throw new Error(`hivewardd_migration_blob_digest_mismatch:${label}`)
    }
  }
}

/** Verified staged files; call after assertHivewarddMigrationBlobsReady in the same synchronous turn. */
export function stagedHivewarddMigrationBlobFiles(
  manifest: HivewarddMigrationManifest,
  root: string
): { descriptor: HivewarddMigrationBlobDescriptor; path: string }[] {
  return stagedBlobDescriptors(root, manifest).map((descriptor) => ({
    descriptor,
    path: stagedBlobPath(root, manifest, descriptor)
  }))
}

/** Reject missing or extra blobs, including leftovers from another capture. */
export function assertHivewarddMigrationBlobSetMatches(
  manifest: HivewarddMigrationManifest,
  root: string,
  expected: readonly HivewarddMigrationBlobDescriptor[]
): void {
  assertHivewarddMigrationBlobSet(expected)
  const wanted = new Map(expected.map((entry) => [hivewarddMigrationBlobIdentity(entry), entry]))
  const staged = stagedBlobDescriptors(root, manifest)
  const stagedIds = new Set(staged.map(hivewarddMigrationBlobIdentity))
  for (const descriptor of staged) {
    const match = wanted.get(hivewarddMigrationBlobIdentity(descriptor))
    if (!match || !sameHivewarddMigrationBlob(match, descriptor)) {
      throw blobSetMismatch(descriptor)
    }
  }
  for (const identity of receivedBlobIdentities(root, manifest)) {
    if (!wanted.has(identity)) {
      throw new Error('hivewardd_migration_blob_set_mismatch')
    }
  }
  for (const descriptor of expected) {
    // Previous commit attempts may have moved these bytes to received.
    if (
      !stagedIds.has(hivewarddMigrationBlobIdentity(descriptor)) &&
      inspectReceivedBlob(root, manifest, descriptor) !== 'matching'
    ) {
      throw blobSetMismatch(descriptor)
    }
  }
}

/** Call assertHivewarddMigrationBlobsReady in the same synchronous turn so no chunk can change verified bytes. */
export function commitHivewarddMigrationBlobs(manifest: HivewarddMigrationManifest, root: string): void {
  const directories = new Set<string>()
  for (const descriptor of stagedBlobDescriptors(root, manifest)) {
    const finalPath = getHivewarddMigrationReceivedBlobPath(root, manifest, descriptor)
    ensureHivewarddMigrationDirectory(dirname(finalPath))
    linkHivewarddMigrationStagedFile({
      stagedPath: stagedBlobPath(root, manifest, descriptor),
      finalPath,
      expected: descriptor,
      conflictError: `hivewardd_migration_blob_destination_conflict:${descriptor.blobKind}:${descriptor.key}`
    })
    directories.add(dirname(finalPath))
  }
  for (const directory of directories) {
    syncDirectoryDurablySync(directory)
  }
  removeHivewarddMigrationStagingDirectory(root, manifest)
}

/** Also remove blobs moved by a commit that never landed. */
export function abortHivewarddMigrationBlobs(manifest: HivewarddMigrationManifest, root: string): void {
  removeHivewarddMigrationStagingDirectory(root, manifest)
  rmSync(receivedBlobsDirectory(root, manifest), { recursive: true, force: true })
}

export function pruneHivewarddMigrationBlobStaging(
  stagedManifests: readonly HivewarddMigrationManifest[],
  committedMigrations: readonly HivewarddMigrationRequestIdentity[],
  root: string
): void {
  pruneHivewarddMigrationStagingDirectories(root, stagedManifests)
  pruneHivewarddMigrationKeyedDirectories(join(root, RECEIVED_DIRECTORY), [
    ...stagedManifests,
    ...committedMigrations
  ])
}

function blobSetMismatch(descriptor: HivewarddMigrationBlobDescriptor): Error {
  return new Error(`hivewardd_migration_blob_set_mismatch:${descriptor.blobKind}:${descriptor.key}`)
}

function receivedBlobIdentities(root: string, manifest: HivewarddMigrationManifest): string[] {
  const received = receivedBlobsDirectory(root, manifest)
  return HIVEWARDD_MIGRATION_BLOB_KINDS.flatMap((blobKind) =>
    readDirectory(join(received, blobKind)).map((key) =>
      hivewarddMigrationBlobIdentity({ blobKind, key })
    )
  )
}

function stagedBlobDescriptors(
  root: string,
  manifest: HivewarddMigrationManifest
): HivewarddMigrationBlobDescriptor[] {
  const staging = hivewarddMigrationStagingDirectory(root, manifest)
  const descriptors: HivewarddMigrationBlobDescriptor[] = []
  for (const blobKind of HIVEWARDD_MIGRATION_BLOB_KINDS) {
    for (const name of readDirectory(join(staging, blobKind))) {
      const match = STAGED_BLOB_NAME.exec(name)
      if (!match) {
        continue
      }
      try {
        descriptors.push(
          parseHivewarddMigrationBlobDescriptor({
            blobKind,
            key: match[1],
            sha256: match[2],
            byteLength: Number(match[3])
          })
        )
      } catch {
        // Foreign names cannot belong to the staged set.
      }
    }
  }
  return descriptors
}

function readDirectory(path: string): string[] {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}

function inspectReceivedBlob(
  root: string,
  manifest: HivewarddMigrationManifest,
  descriptor: HivewarddMigrationBlobDescriptor
): 'absent' | 'matching' | 'conflict' {
  return inspectHivewarddMigrationFinalFile(
    getHivewarddMigrationReceivedBlobPath(root, manifest, descriptor),
    descriptor
  )
}

function receivedBlobsDirectory(root: string, manifest: HivewarddMigrationRequestIdentity): string {
  return join(root, RECEIVED_DIRECTORY, hivewarddMigrationStagingKey(manifest))
}

function stagedBlobPath(
  root: string,
  manifest: HivewarddMigrationManifest,
  descriptor: HivewarddMigrationBlobDescriptor
): string {
  return join(
    hivewarddMigrationStagingDirectory(root, manifest),
    descriptor.blobKind,
    `${descriptor.key}.${descriptor.sha256}.${descriptor.byteLength}.part`
  )
}
