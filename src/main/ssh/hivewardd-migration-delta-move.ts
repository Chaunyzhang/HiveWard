/** Journal only additions made after conversion to the same server; retain the full journal chain and source rows. Stage conflicts leave the changed mark and source intact; uncertain outcomes keep the journal for resume. */
import {
  HIVEWARDD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type HivewarddMigrationSourceCutover
} from '../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import type { HivewarddDeltaMoveResult } from '../../shared/hivewardd-managed-runtime'
import { recordManagedHivewarddMigration } from '../../shared/runtime-environment-managed-hivewardd-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence/loading-store/store'
import {
  abortHivewarddMigrationCutover,
  commitHivewarddMigrationDestination,
  type HivewarddMigrationCutoverContext,
  type HivewarddMigrationDestinationCatalog
} from './hivewardd-migration-cutover-coordinator'
import {
  findHivewarddMigrationSourceCutoverForTarget,
  listHivewarddMigrationCutoverChainForTarget,
  removeHivewarddMigrationSourceCutover,
  writeHivewarddMigrationSourceCutover
} from './hivewardd-migration-cutover-journal'
import {
  committedHivewarddMigrationChain,
  hivewarddDeltaSourceStore,
  planHivewarddDeltaMove,
  unfinishedHivewarddDelta,
  type HivewarddDeltaMovePlan
} from './hivewardd-migration-delta-plan'
import { assertHivewarddMigrationRequestFits } from './hivewardd-migration-manifest-export'
import { retainHivewarddMigrationSource } from './hivewardd-migration-source-retention'
import {
  assessHivewarddMigrationTerminals,
  type HivewarddMigrationTerminalVerdict,
  retireProvenExitedLeases,
  type CensusHostRelayTerminals
} from './hivewardd-migration-terminal-gate'
import {
  currentHivewarddSourceFingerprint,
  hivewarddCatalogFingerprint,
  unmovedHivewarddSourceRows,
  withKeptHivewarddSourceRows
} from './hivewardd-retained-source'
import { collectHivewarddMigrationSourceCatalog } from '../persistence/migrating-hivewardd-catalog/hivewardd-source-catalog'
import type { SshTargetHivewarddClaims } from './targets/ssh-target-hivewardd-claims'
import { hivewarddMigrationRefusalReason } from './hivewardd-migration-refusal-reason'
import { errorMessage } from '../../shared/error-message'

type HivewarddDeltaMoveArgs = {
  userDataPath: string
  store: Store
  claims: SshTargetHivewarddClaims
  target: SshTarget
  environment: KnownRuntimeEnvironment
  /** Build the destination after opening its tunnel: re-pairing during open can replace commit credentials. */
  connectDestination: () => Promise<HivewarddMigrationDestinationCatalog>
  /** Host census proves exit or identifies terminals preserved by the legacy bridge. */
  censusHost?: CensusHostRelayTerminals | null
  /** Serialize journal-through-commit with all other lifecycle changes to this host. */
  runTargetLifecycle: <T>(targetId: string, operation: () => Promise<T>) => Promise<T>
  now?: () => Date
}

export async function runHivewarddDeltaMove(args: HivewarddDeltaMoveArgs): Promise<HivewarddDeltaMoveResult> {
  const { userDataPath, store, target } = args
  const now = args.now ?? (() => new Date())
  const plan = planHivewarddDeltaMove(userDataPath, store, target, { now })
  // Capture baseline with the manifest before awaiting so both describe the same source.
  const planned = currentHivewarddSourceFingerprint(store, target)
  if (!plan.resumes && plan.added.length === 0) {
    return refuse('hivewardd_delta_nothing_new', 'An older build added nothing new to move.')
  }
  if (plan.blockers.length > 0) {
    return {
      ...refuse('hivewardd_migration_preflight_blocked', hivewarddMigrationRefusalReason(plan.blockers)),
      blockers: plan.blockers
    }
  }
  if (!plan.resumes) {
    // Reject before journaling or an unsendable delta could pin the fence permanently.
    assertHivewarddMigrationRequestFits({ manifest: plan.manifest })
  }
  const terminals = await assessHivewarddMigrationTerminals(store, target.id, args.censusHost)
  if (terminals.verdict !== 'exited' && terminals.verdict !== 'bridged') {
    return refuse('hivewardd_migration_terminals', terminals.reason)
  }
  const settled: SettledTerminals = terminals
  retireProvenExitedLeases(store, target.id, terminals)
  return args.runTargetLifecycle(target.id, async () => {
    // Another move may have journaled or finished while waiting for the lifecycle lock.
    const changedAt = store.getSshTarget(target.id)?.hivewarddFence?.sourceChangedAt
    const head = findHivewarddMigrationSourceCutoverForTarget(userDataPath, target.id)
    if (!changedAt || head?.migrationId !== (plan.resumes ?? plan.head).migrationId) {
      return refuse('hivewardd_delta_superseded', 'Another move of this host ran first.')
    }
    // Source remains writable before fencing; edits during census must not silently become the manifest's baseline.
    if (!plan.resumes && planned !== currentHivewarddSourceFingerprint(store, target)) {
      return refuse(
        'hivewardd_delta_source_changed',
        'This host changed while the move was starting. Try the move again.'
      )
    }
    const cutover = plan.resumes ?? journalDelta(args, plan, planned, settled, now)
    return commitDelta(args, plan, cutover, changedAt, now)
  })
}

type SettledTerminals = Extract<HivewarddMigrationTerminalVerdict, { verdict: 'exited' | 'bridged' }>

function journalDelta(
  args: HivewarddDeltaMoveArgs,
  plan: HivewarddDeltaMovePlan,
  planned: string,
  terminals: SettledTerminals,
  now: () => Date
): HivewarddMigrationSourceCutover {
  const timestamp = now().toISOString()
  const cutover: HivewarddMigrationSourceCutover = {
    version: HIVEWARDD_MIGRATION_SOURCE_CUTOVER_VERSION,
    migrationId: plan.manifest.migrationId,
    phase: 'source-fenced',
    startedAt: timestamp,
    updatedAt: timestamp,
    destinationEnvironmentId: plan.environmentId,
    destinationName: plan.head.destinationName,
    sshTargetId: args.target.id,
    sshTargetGeneration: plan.head.sshTargetGeneration,
    manifestSha256: plan.manifest.manifestSha256,
    provenPtyIds: terminals.verdict === 'exited' ? terminals.provenPtyIds : [],
    // COMPAT(legacy-relay-bridge): a move leaves relay terminals running for the bridge too.
    ...(terminals.verdict === 'bridged' ? { bridgedPtyIds: terminals.bridgedPtyIds } : {}),
    supersedesMigrationId: plan.head.migrationId,
    // Retained rows must match the whole source captured with this manifest.
    sourceBaselineFingerprint: planned,
    manifest: plan.manifest
  }
  writeHivewarddMigrationSourceCutover(args.userDataPath, cutover)
  return cutover
}

async function commitDelta(
  args: HivewarddDeltaMoveArgs,
  plan: HivewarddDeltaMovePlan,
  cutover: HivewarddMigrationSourceCutover,
  changedAt: string,
  now: () => Date
): Promise<HivewarddDeltaMoveResult> {
  const { userDataPath, store, target } = args
  // Clear the changed mark and freeze source for the move.
  store.updateSshTarget(target.id, { hivewarddFence: { environmentId: plan.environmentId } })
  await args.claims.flush()
  // Record before any new/resumed commit so rollback cannot cross the migration.
  recordManagedHivewarddMigration(userDataPath, plan.environmentId, now().toISOString())
  let destination: HivewarddMigrationDestinationCatalog
  try {
    destination = await args.connectDestination()
  } catch (error) {
    // No request reached the server; keep the journal for later resume.
    await restoreChangedMark(args, cutover, changedAt)
    throw error
  }
  const context: HivewarddMigrationCutoverContext = {
    userDataPath,
    store: plan.source,
    freshSource: () => hivewarddDeltaSourceStore(store, target, plan.moved, cutover.manifest),
    claims: args.claims,
    destination,
    now
  }
  try {
    const committed = await commitHivewarddMigrationDestination(context, cutover.migrationId)
    if (committed.phase !== 'destination-committed' && committed.phase !== 'source-retired') {
      throw new Error(`hivewardd_migration_commit_not_proven:${committed.phase}`)
    }
  } catch (error) {
    const released = await releaseUncommittedDelta(args, context, cutover, changedAt)
    if (released === 'released') {
      return refuse('hivewardd_delta_refused_by_server', errorMessage(error))
    }
    if (released === 'kept') {
      throw error
    }
  }
  await retainHivewarddMigrationSource(userDataPath, cutover.migrationId, store, now)
  return { outcome: 'moved', migrationId: cutover.migrationId }
}

/** Release only on proven destination absence; otherwise retain journal for resume. Restore the host's changed mark either way. */
async function releaseUncommittedDelta(
  args: HivewarddDeltaMoveArgs,
  context: HivewarddMigrationCutoverContext,
  cutover: HivewarddMigrationSourceCutover,
  changedAt: string
): Promise<'released' | 'committed' | 'kept'> {
  const restoreMark = (): Promise<void> => restoreChangedMark(args, cutover, changedAt)
  try {
    const result = await abortHivewarddMigrationCutover(context, cutover.migrationId, async () => {
      // Restore the mark first so a crash during journal removal leaves a resumable marked host.
      await restoreMark()
      removeHivewarddMigrationSourceCutover(args.userDataPath, cutover.migrationId)
    })
    return result.outcome === 'released' ? 'released' : 'committed'
  } catch {
    await restoreMark()
    return 'kept'
  }
}

async function restoreChangedMark(
  args: Pick<HivewarddDeltaMoveArgs, 'store' | 'claims'>,
  cutover: HivewarddMigrationSourceCutover,
  changedAt: string
): Promise<void> {
  args.store.updateSshTarget(cutover.sshTargetId, {
    hivewarddFence: { environmentId: cutover.destinationEnvironmentId, sourceChangedAt: changedAt }
  })
  await args.claims.flush()
}

/** Keep older-build changes only in retained profile rows. */
export async function keepHivewarddServerVersion(args: {
  userDataPath: string
  store: Store
  claims: SshTargetHivewarddClaims
  target: SshTarget
}): Promise<void> {
  const environmentId = args.target.hivewarddFence?.environmentId
  const chain = listHivewarddMigrationCutoverChainForTarget(args.userDataPath, args.target.id)
  if (unfinishedHivewarddDelta(chain)) {
    // Unfinished moves may already have copied rows; only commit/abort can decide.
    throw new Error('hivewardd_delta_move_unfinished')
  }
  const head = committedHivewarddMigrationChain(chain).at(-1)
  if (!environmentId || !args.target.hivewarddFence?.sourceChangedAt || !head) {
    throw new Error('hivewardd_delta_not_changed')
  }
  const current = collectHivewarddMigrationSourceCatalog(args.store, args.target)
  const unmoved = unmovedHivewarddSourceRows(current, committedHivewarddMigrationChain(chain))
  writeHivewarddMigrationSourceCutover(args.userDataPath, {
    ...withKeptHivewarddSourceRows(head, unmoved),
    // Explicit reconcile accepts the current retained source as the new baseline.
    sourceBaselineFingerprint: hivewarddCatalogFingerprint(current)
  })
  args.store.updateSshTarget(args.target.id, { hivewarddFence: { environmentId } })
  await args.claims.flush()
}

function refuse(
  code: string,
  reason: string
): Extract<HivewarddDeltaMoveResult, { outcome: 'refused' }> {
  return { outcome: 'refused', code, reason }
}
