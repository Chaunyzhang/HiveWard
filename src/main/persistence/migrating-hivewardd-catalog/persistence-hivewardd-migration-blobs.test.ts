import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HivewarddMigrationBlobDescriptor } from '../../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import { getHivewarddMigrationReceivedBlobPath } from './hivewardd-migration-blob-staging'
import { manifest } from './persistence-hivewardd-migration-catalog-fixture'
import { createStore, testState } from '../persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

// Use a blob kind without an installer to isolate channel behavior.
const bytes = Buffer.from('session record one\nsession record two\n')
const blob: HivewarddMigrationBlobDescriptor = {
  blobKind: 'agent-session-records',
  key: 'session-kept',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  byteLength: bytes.length
}

function chunk(input: ReturnType<typeof manifest>, offset: number, end: number) {
  return {
    migrationId: input.migrationId,
    manifestSha256: input.manifestSha256,
    blob,
    offset,
    bytesBase64: bytes.subarray(offset, end).toString('base64')
  }
}

function blobRoot(): string {
  return join(testState.dir, 'hivewardd-migration-blobs')
}

describe('hivewardd migration blobs through the store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'hiveward-migration-blobs-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('reloads staged progress from disk and refuses commit until complete', async () => {
    const input = manifest()
    const store = createStore()
    store.stageHivewarddMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    expect(store.getHivewarddMigrationCatalogState(input)).not.toHaveProperty('blobUploads')
    store.stageHivewarddMigrationBlobChunk(chunk(input, 0, 8))

    const restarted = createStore()
    expect(restarted.getHivewarddMigrationCatalogState(input)).toMatchObject({
      state: 'staged',
      blobUploads: [{ ...blob, receivedBytes: 8 }]
    })
    expect(() => restarted.commitStagedHivewarddMigrationCatalog(input)).toThrow(
      `hivewardd_migration_blob_incomplete:agent-session-records:${blob.key}`
    )
    expect(restarted.getHivewarddMigrationCatalogState(input).state).toBe('staged')

    restarted.stageHivewarddMigrationBlobChunk(chunk(input, 8, bytes.length))
    expect(restarted.commitStagedHivewarddMigrationCatalog(input).state).toBe('committed')
    expect(readFileSync(getHivewarddMigrationReceivedBlobPath(blobRoot(), input, blob))).toEqual(bytes)
  })

  it('commits only the blob set the sender names, and checks nothing when it names none', () => {
    const input = manifest()
    const store = createStore()
    store.stageHivewarddMigrationCatalog(input)
    store.stageHivewarddMigrationBlobChunk(chunk(input, 0, bytes.length))
    const missing: HivewarddMigrationBlobDescriptor = {
      blobKind: 'agent-session-records',
      key: 'session-lost',
      sha256: 'e'.repeat(64),
      byteLength: 4
    }

    expect(() =>
      store.commitStagedHivewarddMigrationCatalog(input, {
        expectedBlobs: [blob, missing]
      })
    ).toThrow('hivewardd_migration_blob_set_mismatch:agent-session-records:session-lost')
    expect(() => store.commitStagedHivewarddMigrationCatalog(input, { expectedBlobs: [] })).toThrow(
      `hivewardd_migration_blob_set_mismatch:agent-session-records:${blob.key}`
    )
    expect(store.getHivewarddMigrationCatalogState(input).state).toBe('staged')
    expect(store.commitStagedHivewarddMigrationCatalog(input, { expectedBlobs: [blob] }).state).toBe(
      'committed'
    )
  })

  it('removes staged blobs when the catalog is aborted', () => {
    const input = manifest()
    const store = createStore()
    store.stageHivewarddMigrationCatalog(input)
    store.stageHivewarddMigrationBlobChunk(chunk(input, 0, 8))

    expect(store.abortStagedHivewarddMigrationCatalog(input)).toMatchObject({ aborted: true })
    expect(() => store.stageHivewarddMigrationBlobChunk(chunk(input, 8, bytes.length))).toThrow(
      'hivewardd_migration_blob_catalog_not_staged'
    )
    store.stageHivewarddMigrationCatalog(input)
    expect(store.getHivewarddMigrationCatalogState(input)).not.toHaveProperty('blobUploads')
  })
})
