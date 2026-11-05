/** Persist journal, fence, then profile flush before remote calls. Crashes may leave a non-authoritative stale journal; a fence without a journal requires destination evidence before release. */
import { randomUUID } from 'node:crypto'
import { getManagedHivewarddFenceEnvironmentId } from '../../shared/managed-hivewardd-ssh-owner'
import type { HivewarddMigrationBlocker } from '../../shared/hivewardd-migration/hivewardd-migration-preflight'
import {
  HIVEWARDD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type HivewarddMigrationSourceCutover
} from '../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import type { SshTarget } from '../../shared/ssh-types'
import {
  assertHivewarddMigrationRequestFits,
  createHivewarddMigrationManifest
} from './hivewardd-migration-manifest-export'
import {
  findHivewarddMigrationSourceCutoverForTarget,
  removeHivewarddMigrationSourceCutover,
  writeHivewarddMigrationSourceCutover
} from './hivewardd-migration-cutover-journal'
import {
  confirmHivewarddMigrationTerminalsUnderFence,
  type HivewarddMigrationTerminalVerdict
} from './hivewardd-migration-terminal-gate'
import type { SshTargetHivewarddClaims } from './targets/ssh-target-hivewardd-claims'
import {
  isBlockingHivewarddMigrationBlocker,
  preflightHivewarddMigrationExport,
  type HivewarddMigrationPreflightStore
} from './targets/ssh-target-hivewardd-preflight'
import { hivewarddMigrationRefusalReason } from './hivewardd-migration-refusal-reason'
import {
  preservesHivewarddMigrationBridgedPanes,
  type HivewarddMigrationPaneLeasePredicate
} from './hivewardd-migration-bridged-panes'

export const HIVEWARDD_MIGRATION_LEAVE_BEHIND_TERMINALS = 'hivewardd_migration_leave_behind_terminals'
export const HIVEWARDD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON =
  'Move anyway needs every terminal on this host closed first, and HiveWard could not confirm they all exited. Close them, or end them on the host, then connect again.'

export type HivewarddMigrationFenceState =
  | { state: 'none' }
  | { state: 'fenced'; cutover: HivewarddMigrationSourceCutover }
  /** Empty-host deploys record provisioning intent instead of a migration journal. */
  | { state: 'owned-by-deploy'; environmentId: string }
  /** Unexplained ownership requires recovery, never automatic release. */
  | { state: 'fenced-unverifiable'; environmentId: string }
  /** Stale journals grant no staging authority. */
  | { state: 'stale-journal'; cutover: HivewarddMigrationSourceCutover }

/** Throws when the journal cannot be read: an unreadable record keeps the host fenced. */
export function resolveHivewarddMigrationFence(
  userDataPath: string,
  target: SshTarget
): HivewarddMigrationFenceState {
  const cutover = findHivewarddMigrationSourceCutoverForTarget(userDataPath, target.id)
  const ownerEnvironmentId = getManagedHivewarddFenceEnvironmentId(target)
  if (cutover) {
    return ownerEnvironmentId === cutover.destinationEnvironmentId &&
      target.generation === cutover.sshTargetGeneration
      ? { state: 'fenced', cutover }
      : { state: 'stale-journal', cutover }
  }
  if (!ownerEnvironmentId) {
    return { state: 'none' }
  }
  return target.hivewarddProvisioning
    ? { state: 'owned-by-deploy', environmentId: ownerEnvironmentId }
    : { state: 'fenced-unverifiable', environmentId: ownerEnvironmentId }
}

export type HivewarddMigrationFenceResult =
  | { outcome: 'fenced'; cutover: HivewarddMigrationSourceCutover; resumed: boolean }
  | {
      outcome: 'refused'
      verdict: 'live' | 'unverifiable'
      code: string
      reason: string
      blockers?: HivewarddMigrationBlocker[]
    }

export async function fenceHivewarddMigrationSource(args: {
  userDataPath: string
  store: HivewarddMigrationPreflightStore
  claims: SshTargetHivewarddClaims
  targetId: string
  destinationEnvironmentId: string
  destinationName: string
  terminalProof: HivewarddMigrationTerminalVerdict
  isBridgedPaneLease?: HivewarddMigrationPaneLeasePredicate
  now?: () => Date
  signal?: AbortSignal
}): Promise<HivewarddMigrationFenceResult> {
  const target = args.store.getSshTarget(args.targetId)
  if (!target) {
    return refuse('unverifiable', 'hivewardd_migration_target_not_found', 'The SSH host is gone.')
  }
  const existing = resolveHivewarddMigrationFence(args.userDataPath, target)
  if (existing.state === 'fenced') {
    return existing.cutover.destinationEnvironmentId === args.destinationEnvironmentId
      ? { outcome: 'fenced', cutover: existing.cutover, resumed: true }
      : refuse('live', 'hivewardd_migration_in_progress', 'Another migration holds this SSH host.')
  }
  if (existing.state !== 'none') {
    return refuse(
      'unverifiable',
      `hivewardd_migration_${existing.state.replaceAll('-', '_')}`,
      fenceStateReason(existing)
    )
  }
  const proof = args.terminalProof
  if (proof.verdict !== 'exited' && proof.verdict !== 'bridged') {
    return refuse(proof.verdict, 'hivewardd_migration_terminals', proof.reason)
  }
  const preflight = preflightHivewarddMigrationExport(
    args.store,
    target.id,
    undefined,
    proof.verdict === 'bridged' ? proof.bridgedPtyIds : []
  )
  if (!preflight.claimable) {
    return {
      ...refuse(
        // Only a proven blocker reads live; one that is merely unanswered stays unverifiable.
        preflight.blockers
          .filter(isBlockingHivewarddMigrationBlocker)
          .every((blocker) => blocker.category === 'live-or-unverifiable')
          ? 'unverifiable'
          : 'live',
        'hivewardd_migration_preflight_blocked',
        hivewarddMigrationRefusalReason(preflight.blockers)
      ),
      blockers: preflight.blockers
    }
  }
  const generation = args.claims.ensureGeneration(target.id)
  const now = (args.now ?? (() => new Date()))().toISOString()
  const manifest = createHivewarddMigrationManifest(
    args.store,
    { ...target, generation },
    { migrationId: randomUUID(), destinationEnvironmentId: args.destinationEnvironmentId }
  )
  if (
    proof.verdict === 'bridged' &&
    target.managedServerLeaveBehind &&
    !preservesHivewarddMigrationBridgedPanes(
      manifest.payload,
      args.store.getSshRemotePtyLeases(target.id),
      proof.bridgedPtyIds,
      args.isBridgedPaneLease
    )
  ) {
    return refuse(
      proof.relayVerdict,
      HIVEWARDD_MIGRATION_LEAVE_BEHIND_TERMINALS,
      HIVEWARDD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON
    )
  }
  // Reject before journaling so an unsendable manifest cannot pin the fence.
  assertHivewarddMigrationRequestFits({ manifest })
  const cutover: HivewarddMigrationSourceCutover = {
    version: HIVEWARDD_MIGRATION_SOURCE_CUTOVER_VERSION,
    migrationId: manifest.migrationId,
    phase: 'source-fenced',
    startedAt: now,
    updatedAt: now,
    destinationEnvironmentId: args.destinationEnvironmentId,
    destinationName: args.destinationName,
    sshTargetId: target.id,
    sshTargetGeneration: generation,
    manifestSha256: manifest.manifestSha256,
    provenPtyIds: proof.verdict === 'exited' ? proof.provenPtyIds : [],
    ...(proof.verdict === 'bridged' ? { bridgedPtyIds: proof.bridgedPtyIds } : {}),
    // Capture before commit; this journaled export is the evidence of what the destination receives.
    manifest
  }
  writeHivewarddMigrationSourceCutover(args.userDataPath, cutover)
  args.claims.fenceForMigration(target.id, args.destinationEnvironmentId, generation)
  await args.claims.flush(args.signal)
  // Recheck under fence for terminals started after the original proof.
  const underFence = confirmHivewarddMigrationTerminalsUnderFence(
    args.store,
    target.id,
    args.terminalProof
  )
  if (underFence.verdict !== 'exited' && underFence.verdict !== 'bridged') {
    await releaseUnstagedFence(args, cutover)
    return refuse(underFence.verdict, 'hivewardd_migration_terminals', underFence.reason)
  }
  return { outcome: 'fenced', cutover, resumed: false }
}

type FenceReleaseArgs = { userDataPath: string; claims: SshTargetHivewarddClaims; signal?: AbortSignal }

async function releaseUnstagedFence(
  args: FenceReleaseArgs,
  cutover: HivewarddMigrationSourceCutover
): Promise<void> {
  if (cutover.phase !== 'source-fenced') {
    throw new Error('hivewardd_migration_fence_release_after_stage')
  }
  await releaseHivewarddMigrationFence(args, cutover)
}

/** Drop owner before journal so an interrupted release leaves a harmless stale journal, never unexplained ownership. */
export async function releaseHivewarddMigrationFence(
  args: FenceReleaseArgs,
  cutover: HivewarddMigrationSourceCutover
): Promise<void> {
  args.claims.release(cutover.sshTargetId, cutover.destinationEnvironmentId)
  await args.claims.flush(args.signal)
  removeHivewarddMigrationSourceCutover(args.userDataPath, cutover.migrationId)
}

/** Unregistered destinations could stage nothing; registered destinations must prove durable abort instead. */
export async function releaseUndeployedMigrationFence(args: {
  userDataPath: string
  claims: SshTargetHivewarddClaims
  targetId: string
  isDestinationRegistered: (environmentId: string) => boolean
  signal?: AbortSignal
}): Promise<'released' | 'none'> {
  const cutover = findHivewarddMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  if (!cutover) {
    return 'none'
  }
  if (args.isDestinationRegistered(cutover.destinationEnvironmentId)) {
    throw new Error('hivewardd_migration_destination_registered')
  }
  await releaseUnstagedFence(args, cutover)
  return 'released'
}

function fenceStateReason(state: HivewarddMigrationFenceState): string {
  switch (state.state) {
    case 'owned-by-deploy':
      return 'HiveWard already runs on this SSH host.'
    case 'fenced-unverifiable':
      return 'This SSH host is held for a migration whose record is missing. Recover it from this host’s HiveWard server first.'
    case 'stale-journal':
      return 'A migration record names this SSH host but its fence is gone. Resolve that migration first.'
    case 'fenced':
    case 'none':
      return 'This SSH host is not in a state a migration can start from.'
  }
}

function refuse(
  verdict: 'live' | 'unverifiable',
  code: string,
  reason: string
): Extract<HivewarddMigrationFenceResult, { outcome: 'refused' }> {
  return { outcome: 'refused', verdict, code, reason }
}
