/** Opaque migration blobs travel beside the signed catalog. Gate each kind by its destination capability:
 * older destinations drop unknown kinds, so clients must refuse before staging. */
import { z } from 'zod'
import {
  HIVEWARDD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
  HivewarddMigrationChunkBase64Schema,
  HivewarddMigrationDigestSchema,
  HivewarddMigrationIdentitySchema,
  decodeHivewarddMigrationChunk
} from './hivewardd-migration-scrollback'
import { requiredRecord } from './hivewardd-migration-dormant-value-validation'
import { assertUniqueKeys } from './hivewardd-migration-manifest-fields'
import { HIVEWARDD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY } from '../hivewardd-runtime-capabilities'

export const HIVEWARDD_MIGRATION_BLOB_KINDS = [
  'terminal-restore-hints',
  'shell-history',
  'agent-session-records',
  'terminal-history'
] as const

export type HivewarddMigrationBlobKind = (typeof HIVEWARDD_MIGRATION_BLOB_KINDS)[number]

type HivewarddMigrationBlobKindContract = {
  /** Filename-safe, dot-free and lowercase, so a key is one path segment on any filesystem. */
  key: RegExp
  maxBytes: number
  capability: string
}

const MIB = 1024 * 1024

export const HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS: Record<
  HivewarddMigrationBlobKind,
  HivewarddMigrationBlobKindContract
> = {
  // One JSON document per migration; the received directory already scopes it to the migration.
  'terminal-restore-hints': {
    key: /^migration$/,
    maxBytes: 4 * MIB,
    capability: 'hivewardd.migration-blob.terminal-restore-hints.v1'
  },
  // `hashWorktreeId` (16 hex) plus the shell whose history file it is.
  'shell-history': {
    key: /^[a-f0-9]{16}-(?:zsh|bash|fish)$/,
    maxBytes: 64 * MIB,
    capability: 'hivewardd.migration-blob.shell-history.v1'
  },
  // The agent session id; agent CLIs mint lowercase UUID-like ids.
  'agent-session-records': {
    key: /^[a-z0-9][a-z0-9_-]{0,127}$/,
    maxBytes: 64 * MIB,
    capability: 'hivewardd.migration-blob.agent-session-records.v1'
  },
  // 16 hex of the pane key's sha256; the session id it restores as travels inside.
  'terminal-history': {
    key: /^[a-f0-9]{16}$/,
    maxBytes: 16 * MIB,
    capability: 'hivewardd.migration-blob.terminal-history.v1'
  }
}

// The same bound the shared chunk decoder enforces for both channels.
export const HIVEWARDD_MIGRATION_BLOB_CHUNK_BYTES = HIVEWARDD_MIGRATION_SCROLLBACK_CHUNK_BYTES
export const MAX_HIVEWARDD_MIGRATION_BLOBS = 1024
export const MAX_HIVEWARDD_MIGRATION_BLOB_TOTAL_BYTES = 256 * MIB

/** Byte-for-byte what the destination must hold; empty content is sent as no blob at all. */
export type HivewarddMigrationBlobDescriptor = {
  blobKind: HivewarddMigrationBlobKind
  key: string
  sha256: string
  byteLength: number
}

export type HivewarddMigrationBlobUploadState = HivewarddMigrationBlobDescriptor & {
  receivedBytes: number
}

export const HIVEWARDD_MIGRATION_DESTINATION_BLOB_KIND_UNSUPPORTED =
  'hivewardd_migration_destination_blob_kind_unsupported'

// Windows refuses these as file names whatever the extension, so a key must never be one.
const WINDOWS_RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i

export const HivewarddMigrationBlobDescriptorSchema = z
  .object({
    blobKind: z.enum(HIVEWARDD_MIGRATION_BLOB_KINDS),
    key: z.string().max(256),
    sha256: HivewarddMigrationDigestSchema,
    byteLength: z.number().int().min(1)
  })
  .superRefine((value, context) => {
    const contract = HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS[value.blobKind]
    if (!contract.key.test(value.key) || WINDOWS_RESERVED_FILE_NAME.test(value.key)) {
      context.addIssue({
        code: 'custom',
        message: 'hivewardd_migration_blob_key_invalid'
      })
    }
    if (value.byteLength > contract.maxBytes) {
      context.addIssue({ code: 'custom', message: 'hivewardd_migration_blob_too_large' })
    }
  })

// Not strict: an older host must ignore optional fields a newer client adds.
export const HivewarddMigrationBlobChunkRequestSchema = z.object({
  migrationId: HivewarddMigrationIdentitySchema,
  manifestSha256: HivewarddMigrationDigestSchema,
  blob: HivewarddMigrationBlobDescriptorSchema,
  offset: z.number().int().nonnegative().max(MAX_HIVEWARDD_MIGRATION_BLOB_TOTAL_BYTES),
  bytesBase64: HivewarddMigrationChunkBase64Schema
})

export type HivewarddMigrationBlobChunkRequest = z.infer<typeof HivewarddMigrationBlobChunkRequestSchema>

export type HivewarddMigrationBlobChunkResult = {
  migrationId: string
  manifestSha256: string
  blobKind: HivewarddMigrationBlobKind
  key: string
  receivedBytes: number
}

export function parseHivewarddMigrationBlobDescriptor(value: unknown): HivewarddMigrationBlobDescriptor {
  const parsed = HivewarddMigrationBlobDescriptorSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'hivewardd_migration_blob_descriptor_invalid')
  }
  return {
    blobKind: parsed.data.blobKind,
    key: parsed.data.key,
    sha256: parsed.data.sha256,
    byteLength: parsed.data.byteLength
  }
}

export function assertHivewarddMigrationBlobSet(
  descriptors: readonly HivewarddMigrationBlobDescriptor[]
): void {
  if (descriptors.length > MAX_HIVEWARDD_MIGRATION_BLOBS) {
    throw new Error('hivewardd_migration_blobs_too_many')
  }
  assertUniqueKeys([...descriptors], hivewarddMigrationBlobIdentity, 'hivewardd_migration_blob_duplicate')
  const total = descriptors.reduce((sum, entry) => sum + entry.byteLength, 0)
  if (total > MAX_HIVEWARDD_MIGRATION_BLOB_TOTAL_BYTES) {
    throw new Error('hivewardd_migration_blobs_too_large')
  }
}

export function hivewarddMigrationBlobIdentity(
  descriptor: Pick<HivewarddMigrationBlobDescriptor, 'blobKind' | 'key'>
): string {
  return `${descriptor.blobKind}\0${descriptor.key}`
}

export function sameHivewarddMigrationBlob(
  left: HivewarddMigrationBlobDescriptor,
  right: HivewarddMigrationBlobDescriptor
): boolean {
  return (
    left.blobKind === right.blobKind &&
    left.key === right.key &&
    left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength
  )
}

/** The channel plus each kind's capability; empty when nothing is sent. */
export function requiredMigrationBlobCapabilities(
  descriptors: readonly Pick<HivewarddMigrationBlobDescriptor, 'blobKind'>[]
): string[] {
  if (descriptors.length === 0) {
    return []
  }
  const kinds = new Set(descriptors.map((entry) => entry.blobKind))
  return [
    HIVEWARDD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
    ...HIVEWARDD_MIGRATION_BLOB_KINDS.filter((kind) => kinds.has(kind)).map(
      (kind) => HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS[kind].capability
    )
  ]
}

/** The first kind the destination cannot install, so the refusal names what would be lost. */
export function findUnsupportedMigrationBlobKind(
  descriptors: readonly Pick<HivewarddMigrationBlobDescriptor, 'blobKind'>[],
  capabilities: readonly string[]
): HivewarddMigrationBlobKind | null {
  const advertised = new Set(capabilities)
  for (const descriptor of descriptors) {
    if (
      !advertised.has(HIVEWARDD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY) ||
      !advertised.has(HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS[descriptor.blobKind].capability)
    ) {
      return descriptor.blobKind
    }
  }
  return null
}

export function hivewarddMigrationBlobKindUnsupportedBlocker(kind: HivewarddMigrationBlobKind): string {
  return `${HIVEWARDD_MIGRATION_DESTINATION_BLOB_KIND_UNSUPPORTED}:${kind}:Update HiveWard on this host to move this project's ${kind} to it.`
}

export function decodeHivewarddMigrationBlobChunk(bytesBase64: string): Buffer {
  return decodeHivewarddMigrationChunk(bytesBase64, 'hivewardd_migration_blob_chunk_invalid')
}

/** Absent on hosts that predate blobs or hold none staged; both mean every blob starts at 0. */
export function parseHivewarddMigrationBlobUploadStates(
  value: unknown
): HivewarddMigrationBlobUploadState[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length > MAX_HIVEWARDD_MIGRATION_BLOBS) {
    throw new Error('hivewardd_migration_blob_state_invalid')
  }
  const uploads = value.map((entry) => {
    // Fails closed on an unknown kind by design: only blobs this desktop staged can appear here.
    const record = requiredRecord(entry, 'hivewardd_migration_blob_state_invalid')
    const descriptor = parseHivewarddMigrationBlobDescriptor(record)
    if (
      !Number.isSafeInteger(record.receivedBytes) ||
      Number(record.receivedBytes) < 0 ||
      Number(record.receivedBytes) > descriptor.byteLength
    ) {
      throw new Error('hivewardd_migration_blob_state_invalid')
    }
    return { ...descriptor, receivedBytes: Number(record.receivedBytes) }
  })
  assertHivewarddMigrationBlobSet(uploads)
  return uploads
}

export function parseHivewarddMigrationBlobChunkResult(
  value: unknown,
  request: HivewarddMigrationBlobChunkRequest
): HivewarddMigrationBlobChunkResult {
  const record = requiredRecord(value, 'hivewardd_migration_blob_chunk_result_invalid')
  const receivedBytes = request.offset + decodeHivewarddMigrationBlobChunk(request.bytesBase64).length
  if (
    record.migrationId !== request.migrationId ||
    record.manifestSha256 !== request.manifestSha256 ||
    record.blobKind !== request.blob.blobKind ||
    record.key !== request.blob.key ||
    record.receivedBytes !== receivedBytes
  ) {
    throw new Error('hivewardd_migration_blob_chunk_result_invalid')
  }
  return {
    migrationId: request.migrationId,
    manifestSha256: request.manifestSha256,
    blobKind: request.blob.blobKind,
    key: request.blob.key,
    receivedBytes
  }
}

/** Kinds this build's destination installs after commit; each is added with its installer. */
export const HIVEWARDD_MIGRATION_INSTALLABLE_BLOB_KINDS: readonly HivewarddMigrationBlobKind[] = [
  'terminal-restore-hints',
  'shell-history',
  'terminal-history'
]

/** Moved panes' terminal history installs only on a WSL host, the one destination a WSL move has. */
export function advertisedHivewarddMigrationBlobCapabilities(host: { wslHost: boolean }): string[] {
  return [
    HIVEWARDD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
    ...HIVEWARDD_MIGRATION_INSTALLABLE_BLOB_KINDS.filter(
      (kind) => kind !== 'terminal-history' || host.wslHost
    ).map((kind) => HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS[kind].capability)
  ]
}
