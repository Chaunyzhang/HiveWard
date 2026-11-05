import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HivewarddMigrationBlobChunkRequest,
  HivewarddMigrationBlobDescriptor
} from '../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import { HIVEWARDD_MIGRATION_MANIFEST_VERSION } from '../../shared/hivewardd-migration/hivewardd-migration-manifest-validation'
import type { HivewarddMigrationManifest } from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import {
  HIVEWARDD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
  HIVEWARDD_MIGRATION_CATALOG_RUNTIME_CAPABILITY
} from '../../shared/hivewardd-runtime-capabilities'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

const sendRequest = vi.hoisted(() => vi.fn())
const status = vi.hoisted((): { capabilities: string[] } => ({ capabilities: [] }))
vi.mock('../../shared/remote-runtime/remote-runtime-client', () => ({
  sendRemoteRuntimeRequestWithStatusPreflight: async (
    pairing: unknown,
    method: string,
    params: unknown,
    _timeoutMs: number,
    validate: (response: unknown) => void
  ) => {
    validate({
      ok: true,
      _meta: { runtimeId: 'runtime' },
      result: { capabilities: status.capabilities }
    })
    return sendRequest(pairing, method, params)
  }
}))

const { commitRemoteHivewarddMigrationCatalog, stageRemoteHivewarddMigrationBlobChunk } =
  await import('./hivewardd-migration-catalog-client')

const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'paired-desktop'
})

const request: HivewarddMigrationBlobChunkRequest = {
  migrationId: 'migration-blob',
  manifestSha256: 'a'.repeat(64),
  blob: {
    blobKind: 'shell-history',
    key: `${'b'.repeat(16)}-zsh`,
    sha256: 'c'.repeat(64),
    byteLength: 3
  },
  offset: 0,
  bytesBase64: 'YWJj'
}

beforeEach(() => {
  vi.clearAllMocks()
  sendRequest.mockResolvedValue({
    ok: true,
    _meta: { runtimeId: 'runtime' },
    result: {
      migrationId: request.migrationId,
      manifestSha256: request.manifestSha256,
      blobKind: 'shell-history',
      key: request.blob.key,
      receivedBytes: 3
    }
  })
})

describe('hivewardd migration blob chunk capability gate', () => {
  it.each([
    ['an older destination', [HIVEWARDD_MIGRATION_CATALOG_RUNTIME_CAPABILITY]],
    [
      'a destination with only the channel',
      [HIVEWARDD_MIGRATION_CATALOG_RUNTIME_CAPABILITY, HIVEWARDD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY]
    ]
  ])('never sends a blob to %s, and names the kind', async (_, capabilities) => {
    status.capabilities = capabilities
    await expect(stageRemoteHivewarddMigrationBlobChunk(pairingCode, request)).rejects.toThrow(
      /^hivewardd_migration_destination_blob_kind_unsupported:shell-history:/
    )
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('sends through its own method once the destination installs the kind', async () => {
    status.capabilities = [
      HIVEWARDD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
      HIVEWARDD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
      'hivewardd.migration-blob.shell-history.v1'
    ]
    await expect(stageRemoteHivewarddMigrationBlobChunk(pairingCode, request)).resolves.toMatchObject({
      receivedBytes: 3
    })
    expect(sendRequest).toHaveBeenCalledWith(
      expect.anything(),
      'hivewardd.migration.stageBlobChunk',
      request
    )
  })
})

describe('hivewardd migration commit names its blob set', () => {
  const manifest: HivewarddMigrationManifest = {
    version: HIVEWARDD_MIGRATION_MANIFEST_VERSION,
    migrationId: request.migrationId,
    createdAt: '2026-08-30T12:00:00.000Z',
    source: {
      sshTargetId: 'source',
      sshTargetGeneration: 1,
      targetLabel: 'Source'
    },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
    manifestSha256: request.manifestSha256
  }
  const expectedBlobs: HivewarddMigrationBlobDescriptor[] = [request.blob]
  const installing = [
    HIVEWARDD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
    HIVEWARDD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
    'hivewardd.migration-blob.shell-history.v1'
  ]

  beforeEach(() => {
    sendRequest.mockResolvedValue({
      ok: true,
      _meta: { runtimeId: 'runtime' },
      result: {
        state: 'staged',
        migrationId: manifest.migrationId,
        manifestSha256: manifest.manifestSha256,
        stagedAt: '2026-08-30T12:00:00.000Z'
      }
    })
  })

  it('sends exactly `{ manifest }` when the move carried no blobs, even to a blob host', async () => {
    for (const capabilities of [[HIVEWARDD_MIGRATION_CATALOG_RUNTIME_CAPABILITY], installing]) {
      status.capabilities = capabilities
      await commitRemoteHivewarddMigrationCatalog(pairingCode, manifest)
      await commitRemoteHivewarddMigrationCatalog(pairingCode, manifest, {
        expectedBlobs: []
      })
      expect(sendRequest).toHaveBeenLastCalledWith(
        expect.anything(),
        'hivewardd.migration.commitCatalog',
        { manifest }
      )
    }
  })

  it('names the blobs to a destination with the channel, and never to one without', async () => {
    status.capabilities = installing
    await commitRemoteHivewarddMigrationCatalog(pairingCode, manifest, {
      expectedBlobs
    })
    expect(sendRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      'hivewardd.migration.commitCatalog',
      { manifest, expectedBlobs }
    )

    sendRequest.mockClear()
    status.capabilities = [HIVEWARDD_MIGRATION_CATALOG_RUNTIME_CAPABILITY]
    await expect(
      commitRemoteHivewarddMigrationCatalog(pairingCode, manifest, {
        expectedBlobs
      })
    ).rejects.toThrow(/^hivewardd_migration_destination_blob_kind_unsupported:shell-history:/)
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
