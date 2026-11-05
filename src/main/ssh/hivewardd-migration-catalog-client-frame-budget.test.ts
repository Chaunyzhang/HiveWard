import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HivewarddMigrationBlobDescriptor } from '../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import type { HivewarddMigrationManifest } from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import {
  MAX_HIVEWARDD_MIGRATION_MANIFEST_BYTES,
  HIVEWARDD_MIGRATION_MANIFEST_VERSION
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest-validation'
import {
  HIVEWARDD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
  HIVEWARDD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY,
  HIVEWARDD_MIGRATION_CATALOG_RUNTIME_CAPABILITY
} from '../../shared/hivewardd-runtime-capabilities'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

const sendRequest = vi.hoisted(() => vi.fn())
const extraCapabilities = vi.hoisted((): string[] => [])
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
      result: {
        capabilities: [
          HIVEWARDD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
          HIVEWARDD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
          'hivewardd.migration-blob.agent-session-records.v1',
          ...extraCapabilities
        ]
      }
    })
    return sendRequest(pairing, method, params)
  }
}))

const { commitRemoteHivewarddMigrationCatalog, stageRemoteHivewarddMigrationCatalog } =
  await import('./hivewardd-migration-catalog-client')
const { abortRemoteHivewarddMigrationCatalogByReference } =
  await import('./hivewardd-migration-catalog-reference-client')

const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'paired-desktop'
})

function manifestOfBytes(bytes: number): HivewarddMigrationManifest {
  const withLabel = (targetLabel: string): HivewarddMigrationManifest => ({
    version: HIVEWARDD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-frame',
    createdAt: '2026-10-18T12:00:00.000Z',
    source: { sshTargetId: 'source', sshTargetGeneration: 1, targetLabel },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
    manifestSha256: 'a'.repeat(64)
  })
  return withLabel('x'.repeat(bytes - JSON.stringify(withLabel('')).length))
}

const manyBlobs: HivewarddMigrationBlobDescriptor[] = Array.from({ length: 200 }, (_, index) => ({
  blobKind: 'agent-session-records',
  key: `session-${index}-${'s'.repeat(64)}`,
  sha256: 'c'.repeat(64),
  byteLength: 1024
}))

beforeEach(() => {
  vi.clearAllMocks()
  extraCapabilities.length = 0
  sendRequest.mockResolvedValue({
    ok: true,
    _meta: { runtimeId: 'runtime' },
    result: {
      state: 'staged',
      migrationId: 'migration-frame',
      manifestSha256: 'a'.repeat(64),
      stagedAt: '2026-10-18T12:00:00.000Z'
    }
  })
})

describe("hivewardd migration requests fit the host's sealed inbound frame", () => {
  it('refuses, unsent, a manifest at the validation cap: sealed, it overflows the 1 MiB frame', async () => {
    await expect(
      stageRemoteHivewarddMigrationCatalog(
        pairingCode,
        manifestOfBytes(MAX_HIVEWARDD_MIGRATION_MANIFEST_BYTES)
      )
    ).rejects.toThrow(/\(hivewardd_migration_manifest_too_large\)$/)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('refuses, unsent, a commit whose blob list pushes a fitting manifest past the frame', async () => {
    const manifest = manifestOfBytes(760 * 1024)
    await expect(
      commitRemoteHivewarddMigrationCatalog(pairingCode, manifest, { expectedBlobs: manyBlobs })
    ).rejects.toThrow(/too large to move to its HiveWard server/)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('aborts a manifest no request can carry by its identity alone, durably', async () => {
    extraCapabilities.push(HIVEWARDD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY)
    const manifest = manifestOfBytes(MAX_HIVEWARDD_MIGRATION_MANIFEST_BYTES)
    const identity = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { ...identity, state: 'absent', aborted: true, durableAbsent: true }
    })
    await expect(
      abortRemoteHivewarddMigrationCatalogByReference(pairingCode, manifest)
    ).resolves.toEqual({ ...identity, state: 'absent', aborted: true, durableAbsent: true })
    expect(sendRequest).toHaveBeenCalledWith(
      expect.anything(),
      'hivewardd.migration.abortCatalogByReference',
      identity
    )

    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { ...identity, state: 'absent', aborted: true }
    })
    await expect(
      abortRemoteHivewarddMigrationCatalogByReference(pairingCode, manifest)
    ).rejects.toThrow('hivewardd_migration_catalog_abort_durability_invalid')
  })
})
