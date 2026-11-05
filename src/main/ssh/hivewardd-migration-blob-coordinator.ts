/** Check every blob kind against destination capabilities before uploading. Resume from staged offsets and confirm lost acknowledgements by re-reading state; never assume delivery or silently omit unsupported data. */
import {
  HIVEWARDD_MIGRATION_BLOB_CHUNK_BYTES,
  type HivewarddMigrationBlobChunkRequest,
  type HivewarddMigrationBlobChunkResult,
  type HivewarddMigrationBlobDescriptor,
  assertHivewarddMigrationBlobSet,
  findUnsupportedMigrationBlobKind,
  hivewarddMigrationBlobIdentity,
  hivewarddMigrationBlobKindUnsupportedBlocker,
  sameHivewarddMigrationBlob
} from '../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import type {
  HivewarddMigrationCatalogState,
  HivewarddMigrationManifest
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'

export type HivewarddMigrationBlobSource = {
  /** Return the descriptor's exact hashed bytes at offset, up to maxBytes. */
  readChunk: (
    descriptor: HivewarddMigrationBlobDescriptor,
    offset: number,
    maxBytes: number
  ) => Promise<Buffer>
}

export type HivewarddMigrationBlobDestination = {
  readCapabilities: () => Promise<readonly string[]>
  readState: (manifest: HivewarddMigrationManifest) => Promise<HivewarddMigrationCatalogState>
  stageChunk: (request: HivewarddMigrationBlobChunkRequest) => Promise<HivewarddMigrationBlobChunkResult>
}

type HivewarddMigrationBlobTransfer = {
  source: HivewarddMigrationBlobSource
  manifest: HivewarddMigrationManifest
  blobs: readonly HivewarddMigrationBlobDescriptor[]
  destination: HivewarddMigrationBlobDestination
}

type StagedCatalogState = Extract<HivewarddMigrationCatalogState, { state: 'staged' }>

export async function transferHivewarddMigrationBlobs(
  transfer: HivewarddMigrationBlobTransfer
): Promise<void> {
  if (transfer.blobs.length === 0) {
    return
  }
  assertHivewarddMigrationBlobSet(transfer.blobs)
  const unsupported = findUnsupportedMigrationBlobKind(
    transfer.blobs,
    await transfer.destination.readCapabilities()
  )
  if (unsupported) {
    throw new Error(hivewarddMigrationBlobKindUnsupportedBlocker(unsupported))
  }
  const offsets = receivedOffsets(transfer, await readStagedState(transfer))
  for (const blob of transfer.blobs) {
    let offset = offsets.get(hivewarddMigrationBlobIdentity(blob)) ?? 0
    while (offset < blob.byteLength) {
      const bytes = await transfer.source.readChunk(
        blob,
        offset,
        Math.min(HIVEWARDD_MIGRATION_BLOB_CHUNK_BYTES, blob.byteLength - offset)
      )
      if (
        bytes.length === 0 ||
        bytes.length > HIVEWARDD_MIGRATION_BLOB_CHUNK_BYTES ||
        offset + bytes.length > blob.byteLength
      ) {
        throw new Error(`hivewardd_migration_source_blob_changed:${blob.blobKind}`)
      }
      const request: HivewarddMigrationBlobChunkRequest = {
        migrationId: transfer.manifest.migrationId,
        manifestSha256: transfer.manifest.manifestSha256,
        blob: { ...blob },
        offset,
        bytesBase64: bytes.toString('base64')
      }
      offset = await stageChunkWithRecovery(transfer, request, offset + bytes.length)
    }
  }
  assertAllReceived(transfer, await readStagedState(transfer))
}

async function readStagedState(transfer: HivewarddMigrationBlobTransfer): Promise<StagedCatalogState> {
  const state = await transfer.destination.readState(transfer.manifest)
  if (state.state !== 'staged') {
    throw new Error('hivewardd_migration_blob_catalog_not_staged')
  }
  return state
}

function receivedOffsets(
  transfer: HivewarddMigrationBlobTransfer,
  state: StagedCatalogState
): Map<string, number> {
  const wanted = new Map(transfer.blobs.map((blob) => [hivewarddMigrationBlobIdentity(blob), blob]))
  const offsets = new Map<string, number>()
  for (const upload of state.blobUploads ?? []) {
    const blob = wanted.get(hivewarddMigrationBlobIdentity(upload))
    // A reused key with different bytes is another capture; restaging would mix them.
    if (!blob || !sameHivewarddMigrationBlob(blob, upload)) {
      throw new Error(`hivewardd_migration_blob_descriptor_conflict:${upload.blobKind}`)
    }
    offsets.set(hivewarddMigrationBlobIdentity(upload), upload.receivedBytes)
  }
  return offsets
}

function assertAllReceived(transfer: HivewarddMigrationBlobTransfer, state: StagedCatalogState): void {
  const received = receivedOffsets(transfer, state)
  for (const blob of transfer.blobs) {
    if (received.get(hivewarddMigrationBlobIdentity(blob)) !== blob.byteLength) {
      throw new Error(`hivewardd_migration_blob_transfer_incomplete:${blob.blobKind}`)
    }
  }
}

async function stageChunkWithRecovery(
  transfer: HivewarddMigrationBlobTransfer,
  request: HivewarddMigrationBlobChunkRequest,
  expectedOffset: number
): Promise<number> {
  try {
    const result = await transfer.destination.stageChunk(request)
    if (result.receivedBytes !== expectedOffset) {
      throw new Error('hivewardd_migration_blob_ack_invalid')
    }
    return result.receivedBytes
  } catch (error) {
    try {
      const observed = await transfer.destination.readState(transfer.manifest)
      const received =
        observed.state === 'staged'
          ? observed.blobUploads?.find(
              (entry) =>
                hivewarddMigrationBlobIdentity(entry) === hivewarddMigrationBlobIdentity(request.blob)
            )?.receivedBytes
          : undefined
      if (received === expectedOffset) {
        return received
      }
    } catch {
      // Unverifiable chunks retain the original failure.
    }
    throw error
  }
}
