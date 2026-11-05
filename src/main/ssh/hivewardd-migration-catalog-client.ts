import { z } from 'zod'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import {
  parseHivewarddMigrationCatalogAbortResult,
  parseHivewarddMigrationCatalogState
} from '../../shared/hivewardd-migration/hivewardd-migration-catalog-state'
import type {
  HivewarddMigrationCatalogAbortResult,
  HivewarddMigrationCatalogState,
  HivewarddMigrationManifest
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import {
  parseHivewarddMigrationSnapshotChunkResult,
  type HivewarddMigrationSnapshotChunkRequest,
  type HivewarddMigrationSnapshotChunkResult
} from '../../shared/hivewardd-migration/hivewardd-migration-scrollback'
import {
  findUnsupportedMigrationBlobKind,
  hivewarddMigrationBlobKindUnsupportedBlocker,
  parseHivewarddMigrationBlobChunkResult,
  type HivewarddMigrationBlobChunkRequest,
  type HivewarddMigrationBlobChunkResult,
  type HivewarddMigrationBlobDescriptor
} from '../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import { parsePairingCode } from '../../shared/pairing'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { HIVEWARDD_MIGRATION_CATALOG_RUNTIME_CAPABILITY } from '../../shared/hivewardd-runtime-capabilities'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime/remote-runtime-client'
import { assertHivewarddMigrationRequestFits } from './hivewardd-migration-manifest-export'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { hasExtraAgentArgs } from '../../shared/automation-extra-agent-args'
import { requiredHivewarddMigrationSourceCapability } from '../../shared/hivewardd-migration/hivewardd-migration-source-kind'
import type { HivewarddServerRepository } from './hivewardd-migration-repository-link'

type HivewarddCatalogMigrationOperation = 'abort' | 'commit' | 'stage' | 'state'

/** Missing capability/method is definite refusal; other failures require catalog re-read because a lost reply may hide staged state. */
export const HIVEWARDD_MIGRATION_DESTINATION_UNSUPPORTED = 'hivewardd_migration_destination_unsupported'
/** Refuse older destinations that would silently strip extra agent arguments. */
export const HIVEWARDD_MIGRATION_DESTINATION_EXTRA_AGENT_ARGS_UNSUPPORTED =
  'hivewardd_migration_destination_extra_agent_args_unsupported:Update HiveWard on this host to use extra arguments.'
/** Unsupported source kinds are refused before any staging request. */
export const HIVEWARDD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED =
  'hivewardd_migration_destination_source_kind_unsupported:Update HiveWard on this host to move this project to it.'

export type CatalogRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  expectedRuntimeId?: string
}

const METHOD_BY_OPERATION: Record<HivewarddCatalogMigrationOperation, string> = {
  abort: 'hivewardd.migration.abortCatalog',
  commit: 'hivewardd.migration.commitCatalog',
  stage: 'hivewardd.migration.stageCatalog',
  state: 'hivewardd.migration.catalogState'
}

export function stageRemoteHivewarddMigrationCatalog(
  pairingCode: string,
  manifest: HivewarddMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<HivewarddMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'stage', manifest, options)
}

/** Expected blobs make the destination refuse incomplete commits. */
export async function commitRemoteHivewarddMigrationCatalog(
  pairingCode: string,
  manifest: HivewarddMigrationManifest,
  options: CatalogRequestOptions & {
    expectedBlobs?: readonly HivewarddMigrationBlobDescriptor[]
  } = {}
): Promise<HivewarddMigrationCatalogState> {
  const result = await request(pairingCode, 'commit', manifest, options, options.expectedBlobs)
  return parseHivewarddMigrationCatalogState(result, manifest)
}

export function readRemoteHivewarddMigrationCatalogState(
  pairingCode: string,
  manifest: HivewarddMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<HivewarddMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'state', manifest, options)
}

export async function abortRemoteHivewarddMigrationCatalog(
  pairingCode: string,
  manifest: HivewarddMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<HivewarddMigrationCatalogAbortResult> {
  const result = await request(pairingCode, 'abort', manifest, options)
  const parsed = parseHivewarddMigrationCatalogAbortResult(result, manifest)
  // Older already-absent replies prove no durability, unlike real aborts.
  if (parsed.state === 'absent' && !parsed.aborted && parsed.durableAbsent !== true) {
    throw new Error('hivewardd_migration_abort_durability_unverifiable:destination_update_required')
  }
  return parsed
}

export async function stageRemoteHivewarddMigrationSnapshotChunk(
  pairingCode: string,
  request: HivewarddMigrationSnapshotChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<HivewarddMigrationSnapshotChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('hivewardd_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'hivewardd.migration.stageSnapshotChunk',
    request,
    options
  )
  if (!response.ok) {
    throw new Error(`hivewardd_migration_snapshot_failed:${response.error.message}`)
  }
  return parseHivewarddMigrationSnapshotChunkResult(response.result, request)
}

export async function stageRemoteHivewarddMigrationBlobChunk(
  pairingCode: string,
  request: HivewarddMigrationBlobChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<HivewarddMigrationBlobChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('hivewardd_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'hivewardd.migration.stageBlobChunk',
    request,
    options,
    false,
    null,
    // Recheck every request so a downgraded destination cannot stage an unsupported blob kind.
    (capabilities) => {
      const unsupported = findUnsupportedMigrationBlobKind([request.blob], capabilities)
      if (unsupported) {
        throw new Error(hivewarddMigrationBlobKindUnsupportedBlocker(unsupported))
      }
    }
  )
  if (!response.ok) {
    throw new Error(`hivewardd_migration_blob_failed:${response.error.message}`)
  }
  return parseHivewarddMigrationBlobChunkResult(response.result, request)
}

export async function listServerRows(
  pairingCode: string,
  method: string,
  rows: string,
  options: CatalogRequestOptions
): Promise<unknown> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('hivewardd_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(pairing, method, undefined, options)
  if (!response.ok) {
    throw new Error(`hivewardd_migration_${rows}_failed:${response.error.message}`)
  }
  return response.result
}

// repo.list returns full stored rows; omitted host fields identify server-local repos.
const ServerRepositoriesSchema = z.object({
  repos: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      connectionId: z.string().nullish(),
      executionHostId: z.string().nullish(),
      projectGroupId: z.string().nullish()
    })
  )
})

export async function listRemoteHivewarddRepositories(
  pairingCode: string,
  options: CatalogRequestOptions = {}
): Promise<HivewarddServerRepository[]> {
  const result = await listServerRows(pairingCode, 'repo.list', 'repositories', options)
  return ServerRepositoriesSchema.parse(result).repos.map(
    ({ id, path, connectionId, executionHostId, projectGroupId }) => ({
      id,
      path,
      ...(connectionId != null ? { connectionId } : {}),
      ...(executionHostId != null ? { executionHostId } : {}),
      ...(projectGroupId != null ? { projectGroupId } : {})
    })
  )
}

async function requestCatalogState(
  pairingCode: string,
  operation: Exclude<HivewarddCatalogMigrationOperation, 'abort'>,
  manifest: HivewarddMigrationManifest,
  options: CatalogRequestOptions
): Promise<HivewarddMigrationCatalogState> {
  const result = await request(pairingCode, operation, manifest, options)
  return parseHivewarddMigrationCatalogState(result, manifest)
}

async function request(
  pairingCode: string,
  operation: HivewarddCatalogMigrationOperation,
  manifest: HivewarddMigrationManifest,
  options: CatalogRequestOptions,
  expectedBlobs: readonly HivewarddMigrationBlobDescriptor[] = []
): Promise<unknown> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('hivewardd_migration_pairing_code_invalid')
  }
  // Preserve exact { manifest } wire shape for blob-free and SSH moves.
  const params = expectedBlobs.length > 0 ? { manifest, expectedBlobs } : { manifest }
  // Validation-size limits can exceed sealed-frame capacity; reject before the host closes the socket.
  assertHivewarddMigrationRequestFits(params)
  const carriesExtraAgentArgs =
    (operation === 'stage' || operation === 'commit') &&
    (manifest.payload.dormantState?.automations ?? []).some((automation) =>
      hasExtraAgentArgs(automation.extraAgentArgs)
    )
  const response = await sendSupportedMigrationRequest(
    pairing,
    METHOD_BY_OPERATION[operation],
    params,
    options,
    carriesExtraAgentArgs,
    // Recheck source capabilities on every operation; older hosts may misparse non-SSH sources.
    requiredHivewarddMigrationSourceCapability(manifest.source),
    // Hosts without blob capability would strip expectedBlobs and commit unchecked.
    (capabilities) => {
      const unsupported = findUnsupportedMigrationBlobKind(expectedBlobs, capabilities)
      if (unsupported) {
        throw new Error(hivewarddMigrationBlobKindUnsupportedBlocker(unsupported))
      }
    }
  )
  if (!response.ok) {
    throw new Error(`hivewardd_migration_${operation}_failed:${response.error.message}`)
  }
  return response.result
}

export async function sendSupportedMigrationRequest(
  pairing: NonNullable<ReturnType<typeof parsePairingCode>>,
  method: string,
  params: unknown,
  options: CatalogRequestOptions,
  requiresExtraAgentArgs = false,
  requiredSourceCapability: string | null = null,
  assertCapabilities: (capabilities: readonly string[]) => void = () => {}
): Promise<RuntimeRpcResponse<unknown>> {
  const response = await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
    pairedRuntimeConnectionFromOffer(pairing),
    method,
    params,
    options.timeoutMs ?? 15_000,
    (status) => {
      if (!status.ok) {
        throw new Error(`hivewardd_migration_status_failed:${status.error.message}`)
      }
      if (
        options.expectedRuntimeId !== undefined &&
        status._meta?.runtimeId !== options.expectedRuntimeId
      ) {
        throw new Error('hivewardd_migration_destination_runtime_mismatch')
      }
      if (!status.result.capabilities?.includes(HIVEWARDD_MIGRATION_CATALOG_RUNTIME_CAPABILITY)) {
        throw new Error(HIVEWARDD_MIGRATION_DESTINATION_UNSUPPORTED)
      }
      if (
        requiresExtraAgentArgs &&
        !status.result.capabilities?.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)
      ) {
        throw new Error(HIVEWARDD_MIGRATION_DESTINATION_EXTRA_AGENT_ARGS_UNSUPPORTED)
      }
      if (
        requiredSourceCapability !== null &&
        !status.result.capabilities?.includes(requiredSourceCapability)
      ) {
        throw new Error(HIVEWARDD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED)
      }
      assertCapabilities(status.result.capabilities ?? [])
    },
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    options.signal
  )
  if (!response.ok && response.error.code === 'method_not_found') {
    throw new Error(HIVEWARDD_MIGRATION_DESTINATION_UNSUPPORTED)
  }
  if (
    options.expectedRuntimeId !== undefined &&
    response._meta?.runtimeId !== options.expectedRuntimeId
  ) {
    throw new Error('hivewardd_migration_destination_runtime_mismatch')
  }
  return response
}
