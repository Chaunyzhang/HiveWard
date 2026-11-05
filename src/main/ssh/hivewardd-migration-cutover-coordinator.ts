/** Keep source authority until durable destination commit. Verify the fenced export before stage/commit; resolve lost replies by catalog reads and persist journal transitions before returning. Never release a committed destination. */
import type {
  HivewarddMigrationCatalogAbortResult,
  HivewarddMigrationCatalogReference,
  HivewarddMigrationCatalogReferenceAbortResult,
  HivewarddMigrationCatalogState,
  HivewarddMigrationManifest
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type {
  HivewarddMigrationSnapshotChunkRequest,
  HivewarddMigrationSnapshotChunkResult
} from '../../shared/hivewardd-migration/hivewardd-migration-scrollback'
import type {
  HivewarddMigrationSourceCutover,
  HivewarddMigrationSourceCutoverPhase
} from '../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import { resolveDurableHivewarddCatalogMutation } from './hivewardd-catalog-durable-mutation'
import { HIVEWARDD_MIGRATION_DESTINATION_UNSUPPORTED } from './hivewardd-migration-catalog-client'
import { hivewarddMigrationRequestFits } from './hivewardd-migration-manifest-export'
import {
  listHivewarddMigrationSourceCutovers,
  writeHivewarddMigrationSourceCutover
} from './hivewardd-migration-cutover-journal'
import type { HivewarddMigrationSourceCutoverPort } from './hivewardd-migration-source'
import {
  transferHivewarddMigrationSnapshots,
  type HivewarddMigrationSnapshotSource
} from './hivewardd-migration-snapshot-coordinator'
import type { HivewarddMigrationPreflightStore } from './targets/ssh-target-hivewardd-preflight'
import { sshRelayMigrationCutoverPort } from './hivewardd-migration-ssh-relay-source'
import type { SshTargetHivewarddClaims } from './targets/ssh-target-hivewardd-claims'

export type HivewarddMigrationDestinationCatalog = {
  readState: (manifest: HivewarddMigrationManifest) => Promise<HivewarddMigrationCatalogState>
  stage: (manifest: HivewarddMigrationManifest) => Promise<HivewarddMigrationCatalogState>
  commit: (manifest: HivewarddMigrationManifest) => Promise<HivewarddMigrationCatalogState>
  abort: (manifest: HivewarddMigrationManifest) => Promise<HivewarddMigrationCatalogAbortResult>
  /** Use identity-only abort when the journal's full manifest cannot fit a request. */
  abortByReference: (
    manifest: HivewarddMigrationCatalogReference
  ) => Promise<HivewarddMigrationCatalogReferenceAbortResult>
  stageChunk: (
    request: HivewarddMigrationSnapshotChunkRequest
  ) => Promise<HivewarddMigrationSnapshotChunkResult>
}

export type HivewarddMigrationCutoverContext = {
  userDataPath: string
  store: HivewarddMigrationPreflightStore & HivewarddMigrationSnapshotSource
  claims: SshTargetHivewarddClaims
  destination: HivewarddMigrationDestinationCatalog
  /** Rebuild copied stores for each check so concurrent edits remain visible. */
  freshSource?: () => HivewarddMigrationPreflightStore
  /** The fenced source; defaults to the relay-era SSH target the journal names. */
  source?: HivewarddMigrationSourceCutoverPort
  now?: () => Date
}

function cutoverSource(context: HivewarddMigrationCutoverContext): HivewarddMigrationSourceCutoverPort {
  return context.source ?? sshRelayMigrationCutoverPort(context)
}

export async function stageHivewarddMigrationDestination(
  context: HivewarddMigrationCutoverContext,
  migrationId: string
): Promise<HivewarddMigrationSourceCutover> {
  let cutover = requireCutover(context.userDataPath, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    return cutover
  }
  assertSourceUnchanged(context, cutover)
  const { destination } = context
  const read = await destination.readState(cutover.manifest)
  const state =
    read.state === 'committed'
      ? await confirmDurableCommit(destination, cutover.manifest)
      : await resolveDurableHivewarddCatalogMutation(
          () => destination.stage(cutover.manifest),
          () => destination.readState(cutover.manifest),
          (observed) => observed.state !== 'absent'
        )
  cutover = recordObservedState(context, cutover, state)
  if (state.state === 'staged') {
    await transferHivewarddMigrationSnapshots({
      source: context.store,
      manifest: cutover.manifest,
      state,
      destination: { readState: destination.readState, stageChunk: destination.stageChunk }
    })
  }
  return cutover
}

export async function commitHivewarddMigrationDestination(
  context: HivewarddMigrationCutoverContext,
  migrationId: string
): Promise<HivewarddMigrationSourceCutover> {
  const staged = await stageHivewarddMigrationDestination(context, migrationId)
  if (staged.phase !== 'destination-staged') {
    return staged
  }
  assertSourceUnchanged(context, staged)
  const { destination } = context
  // A lost commit reply may hide success; catalog read decides the next step.
  const state = await resolveDurableHivewarddCatalogMutation(
    () => destination.commit(staged.manifest),
    () => destination.readState(staged.manifest),
    (observed) => observed.state === 'committed'
  )
  if (state.state !== 'committed') {
    throw new Error(`hivewardd_migration_commit_not_committed:${state.state}`)
  }
  return recordObservedState(context, staged, state)
}

export type HivewarddMigrationAbortResult =
  | { outcome: 'released'; evidence: 'catalog-absent' | 'destination-unsupported' }
  | { outcome: 'refused'; code: string; reason: string }

/** Release only on proven destination absence; default drops journal/fence, while delta moves retain the fence. */
export async function abortHivewarddMigrationCutover(
  context: HivewarddMigrationCutoverContext,
  migrationId: string,
  release: (cutover: HivewarddMigrationSourceCutover) => Promise<void> = (cutover) =>
    cutoverSource(context).releaseFence(cutover)
): Promise<HivewarddMigrationAbortResult> {
  const cutover = requireCutover(context.userDataPath, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    return committedRefusal()
  }
  const { destination } = context
  // Older journals can hold oversized manifests; identity-only abort must still release them.
  if (!hivewarddMigrationRequestFits({ manifest: cutover.manifest })) {
    const aborted = await destination.abortByReference(cutover.manifest)
    if (aborted.state === 'committed') {
      return committedRefusal()
    }
    await release(cutover)
    return { outcome: 'released', evidence: 'catalog-absent' }
  }
  let state: HivewarddMigrationCatalogState
  try {
    state = await destination.readState(cutover.manifest)
  } catch (error) {
    // Unsupported proves absence only before any stage could have landed.
    if (isDestinationUnsupported(error) && cutover.phase === 'source-fenced') {
      await release(cutover)
      return { outcome: 'released', evidence: 'destination-unsupported' }
    }
    throw error
  }
  if (state.state !== 'committed') {
    state = await abortWithRecovery(destination, cutover.manifest)
  }
  if (state.state === 'committed') {
    recordObservedState(context, cutover, await confirmDurableCommit(destination, cutover.manifest))
    return committedRefusal()
  }
  if (state.state !== 'absent') {
    throw new Error(`hivewardd_migration_abort_not_absent:${state.state}`)
  }
  await release(cutover)
  return { outcome: 'released', evidence: 'catalog-absent' }
}

/** Committed reads may be unflushed memory; require the idempotent commit acknowledgement to prove durability. */
export async function confirmDurableCommit(
  destination: HivewarddMigrationDestinationCatalog,
  manifest: HivewarddMigrationManifest
): Promise<HivewarddMigrationCatalogState> {
  const state = await destination.commit(manifest)
  if (state.state !== 'committed') {
    throw new Error(`hivewardd_migration_commit_not_committed:${state.state}`)
  }
  return state
}

function assertSourceUnchanged(
  context: HivewarddMigrationCutoverContext,
  cutover: HivewarddMigrationSourceCutover
): void {
  cutoverSource(context).verifyFence(cutover)
}

/** Persist observed state before returning. */
function recordObservedState(
  context: HivewarddMigrationCutoverContext,
  cutover: HivewarddMigrationSourceCutover,
  state: HivewarddMigrationCatalogState
): HivewarddMigrationSourceCutover {
  if (state.state === 'absent') {
    throw new Error('hivewardd_migration_destination_catalog_absent')
  }
  if (
    state.migrationId !== cutover.migrationId ||
    state.manifestSha256 !== cutover.manifestSha256
  ) {
    throw new Error('hivewardd_migration_destination_state_mismatch')
  }
  if (
    state.state === 'committed' &&
    (state.receipt.migrationId !== cutover.migrationId ||
      state.receipt.manifestSha256 !== cutover.manifestSha256)
  ) {
    throw new Error('hivewardd_migration_destination_receipt_mismatch')
  }
  const phase: HivewarddMigrationSourceCutoverPhase =
    state.state === 'committed' ? 'destination-committed' : 'destination-staged'
  if (phase === cutover.phase) {
    return cutover
  }
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    // Never regress a proven commit.
    return cutover
  }
  const next: HivewarddMigrationSourceCutover = {
    ...cutover,
    phase,
    updatedAt: (context.now ?? (() => new Date()))().toISOString()
  }
  writeHivewarddMigrationSourceCutover(context.userDataPath, next)
  return next
}

/** Aborts staging; a failed abort is decided by a re-read, never assumed. */
export async function abortWithRecovery(
  destination: HivewarddMigrationDestinationCatalog,
  manifest: HivewarddMigrationManifest
): Promise<HivewarddMigrationCatalogState> {
  try {
    return await destination.abort(manifest)
  } catch (abortError) {
    try {
      const observed = await destination.readState(manifest)
      if (observed.state === 'committed') {
        return observed
      }
      if (observed.state === 'absent') {
        // Absent reads may predate flush; repeat abort to prove durable absence.
        return await destination.abort(manifest)
      }
    } catch {
      // Keep the original failure and fence while abort remains unverifiable.
    }
    throw abortError
  }
}

function requireCutover(userDataPath: string, migrationId: string): HivewarddMigrationSourceCutover {
  const cutover = listHivewarddMigrationSourceCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover) {
    throw new Error('hivewardd_migration_source_cutover_not_found')
  }
  return cutover
}

function committedRefusal(): HivewarddMigrationAbortResult {
  return {
    outcome: 'refused',
    code: 'hivewardd_migration_committed_source_cannot_be_released',
    reason: 'This host’s HiveWard server already holds this migration; it can only move forward.'
  }
}

function isDestinationUnsupported(error: unknown): boolean {
  return error instanceof Error && error.message === HIVEWARDD_MIGRATION_DESTINATION_UNSUPPORTED
}
