// Resume journaled migrations after lost contact; source rows stay authoritative until proven commit.
// Retain source rows afterwards for downgrade compatibility.
import { randomUUID } from 'node:crypto'
import type { HivewarddManagedConversionResult } from '../../../shared/hivewardd-managed-runtime'
import type { HivewarddMigrationSourceCutover } from '../../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import { recordManagedHivewarddMigration } from '../../../shared/runtime-environment-managed-hivewardd-store'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import {
  getHivewarddSshDeployment,
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { runTargetLifecycle } from '../../ipc/ssh/ssh-target-lifecycle-queue'
import { environmentMatchesManagedHivewarddCutover } from './hivewardd-managed-migration-status'
import { requireManagedHivewarddInfrastructure } from './hivewardd-managed-runtime-context'
import { ensureHivewarddManagedTunnel } from './hivewardd-managed-tunnel'
import {
  commitHivewarddMigrationDestination,
  type HivewarddMigrationDestinationCatalog
} from '../../ssh/hivewardd-migration-cutover-coordinator'
import {
  findHivewarddMigrationSourceCutoverForTarget,
  removeHivewarddMigrationJournalsForDestination
} from '../../ssh/hivewardd-migration-cutover-journal'
import type { SshTarget } from '../../../shared/ssh-types'
import type { CensusHostRelayTerminals } from '../../ssh/hivewardd-migration-terminal-gate'
import { createManagedHivewarddEnvironment } from './hivewardd-runtime-deployment'
import { createSshRelayMigrationSource } from '../../ssh/hivewardd-migration-ssh-relay-source'
import {
  leaveBehindClearsHivewarddMigrationBlockers,
  onlyLeavableHivewarddMigrationBlockers
} from '../../ssh/targets/ssh-target-hivewardd-preflight'
import { HIVEWARDD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON } from '../../ssh/hivewardd-migration-source-fence'
import type { HivewarddMigrationPaneLeasePredicate } from '../../ssh/hivewardd-migration-bridged-panes'
import { retainHivewarddMigrationSource } from '../../ssh/hivewardd-migration-source-retention'
import {
  enableMovedHivewarddAutomations,
  type EnableServerAutomation
} from '../../ssh/hivewardd-migration-moved-automations'
import {
  linkedHivewarddMigrationCutoverPort,
  linkedHivewarddMigrationProjects,
  linkServerHeldRepositories,
  type HivewarddServerRepository
} from '../../ssh/hivewardd-migration-repository-link'
import type { HivewarddServerFolderCatalog } from '../../ssh/hivewardd-server-folder-workspaces'

export type HivewarddManagedConversionArgs = {
  sshTargetId: string
  name: string
  censusHost?: ((target: SshTarget) => ReturnType<CensusHostRelayTerminals>) | null
  isBridgedPaneLease?: HivewarddMigrationPaneLeasePredicate
  destinationFor: (environment: KnownRuntimeEnvironment) => HivewarddMigrationDestinationCatalog
  /** Link matching host paths to existing server projects. */
  serverRepositoriesFor?: (environment: KnownRuntimeEnvironment) => Promise<HivewarddServerRepository[]>
  /** Link folder workspaces already present from earlier moves. */
  serverFolderCatalogFor?: (
    environment: KnownRuntimeEnvironment
  ) => Promise<HivewarddServerFolderCatalog>
  releaseDirectSession?: (sshTargetId: string) => Promise<void>
  /** Re-enables moved automations that ran on this desktop. */
  serverAutomationEnablerFor?: (environment: KnownRuntimeEnvironment) => EnableServerAutomation
  now?: () => Date
  signal?: AbortSignal
}

export async function convertSshTargetToManagedHivewardd(
  userDataPath: string,
  args: HivewarddManagedConversionArgs
): Promise<HivewarddManagedConversionResult> {
  const fenced = await fenceOrResume(userDataPath, args)
  if ('outcome' in fenced) {
    return fenced
  }
  const deployed = await createManagedHivewarddEnvironment(userDataPath, {
    name: fenced.destinationName,
    sshTargetId: fenced.sshTargetId,
    migration: true,
    signal: args.signal
  })
  if (deployed.outcome === 'deferred') {
    return deployed // Retain fence and journal for a later resume.
  }
  const environment = listEnvironments(userDataPath).find(
    (entry) => entry.id === fenced.destinationEnvironmentId
  )
  if (!environment || !environmentMatchesManagedHivewarddCutover(environment, fenced)) {
    throw new Error('hivewardd_migration_destination_environment_mismatch')
  }
  // Record before commit so crashes cannot allow rollback across migrated state.
  recordManagedHivewarddMigration(
    userDataPath,
    environment.id,
    (args.now ?? (() => new Date()))().toISOString()
  )
  // Tunnel repair may replace pairing credentials; use its returned environment for every request.
  const marked = await ensureHivewarddManagedTunnel(userDataPath, environment.id)
  const { claims, targetStore } = requireManagedHivewarddInfrastructure()
  const store = targetStore.getHivewarddMigrationSource()
  const destination = args.destinationFor(marked)
  const serverRepositoriesFor = args.serverRepositoriesFor
  const serverFolderCatalogFor = args.serverFolderCatalogFor
  let linked: Pick<
    HivewarddMigrationSourceCutover,
    'linkedRepositoryIds' | 'linkedFolderWorkspaceIds'
  > = {}
  const committed = await runTargetLifecycle(fenced.sshTargetId, async () => {
    const journaled = requireJournaledCutover(userDataPath, fenced)
    const cutover = serverRepositoriesFor
      ? await linkServerHeldRepositories({
          userDataPath,
          store,
          claims,
          cutover: journaled,
          destination,
          serverRepositories: () => serverRepositoriesFor(marked),
          ...(serverFolderCatalogFor
            ? { serverFolderCatalog: () => serverFolderCatalogFor(marked) }
            : {}),
          now: args.now
        })
      : journaled
    linked = cutover
    return commitHivewarddMigrationDestination(
      {
        userDataPath,
        store,
        claims,
        source: linkedHivewarddMigrationCutoverPort({ userDataPath, store, claims, cutover }),
        destination,
        now: args.now
      },
      cutover.migrationId
    )
  })
  if (committed.phase !== 'destination-committed' && committed.phase !== 'source-retired') {
    throw new Error(`hivewardd_migration_commit_not_proven:${committed.phase}`)
  }
  let automationsLeftDisabled = 0
  if (committed.phase === 'destination-committed') {
    await retainHivewarddMigrationSource(userDataPath, committed.migrationId, store, args.now)
    if (args.serverAutomationEnablerFor) {
      automationsLeftDisabled = await enableMovedHivewarddAutomations(
        userDataPath,
        committed.migrationId,
        args.serverAutomationEnablerFor(marked)
      ).catch((error: unknown) => {
        console.warn('[ssh] Could not re-enable moved automations:', error)
        return 0
      })
    }
  }
  const linkedProjects = linkedHivewarddMigrationProjects(store, linked)
  return {
    outcome: 'converted',
    environment: redactRuntimeEnvironment(marked),
    migrationId: committed.migrationId,
    ...(linkedProjects.length > 0 ? { linkedProjects } : {}),
    ...(automationsLeftDisabled > 0 ? { automationsLeftDisabled } : {})
  }
}

async function fenceOrResume(
  userDataPath: string,
  args: HivewarddManagedConversionArgs
): Promise<
  HivewarddMigrationSourceCutover | Extract<HivewarddManagedConversionResult, { outcome: 'refused' }>
> {
  const { claims, targetStore } = requireManagedHivewarddInfrastructure()
  const target = targetStore.getTarget(args.sshTargetId)
  if (!target) {
    return refuse('unverifiable', 'hivewardd_migration_target_not_found', 'The SSH host is gone.')
  }
  const store = targetStore.getHivewarddMigrationSource()
  const censusHost = args.censusHost
  const source = createSshRelayMigrationSource({
    userDataPath,
    store,
    claims,
    target,
    censusHost: censusHost ? () => censusHost(target) : null,
    isBridgedPaneLease: args.isBridgedPaneLease
  })
  const existing = source.resolveFence()
  if (existing.state === 'fenced') {
    return existing.cutover
  }
  const stale = existing.state === 'stale-journal' ? existing.cutover : null
  if (stale && !isRegistered(userDataPath, stale.destinationEnvironmentId)) {
    removeHivewarddMigrationJournalsForDestination(
      userDataPath,
      target.id,
      stale.destinationEnvironmentId
    )
  }
  const converted = listEnvironments(userDataPath).some(
    (environment) => getHivewarddSshDeployment(environment)?.sshTargetId === target.id
  )
  if (converted) {
    return refuse(
      'live',
      'hivewardd_migration_already_managed',
      'HiveWard already runs on this SSH host.'
    )
  }
  // Source fencing rechecks leases after acquisition.
  const terminalProof = await source.assessTerminals()
  if (terminalProof.verdict === 'live' || terminalProof.verdict === 'unverifiable') {
    return refuse(terminalProof.verdict, 'hivewardd_migration_terminals', terminalProof.reason)
  }
  source.retireProvenExitedTerminals(terminalProof)
  await args.releaseDirectSession?.(target.id)
  const result = await runTargetLifecycle(target.id, () =>
    source.acquireFence({
      destinationEnvironmentId: randomUUID(),
      destinationName: args.name,
      terminalProof,
      now: args.now,
      signal: args.signal
    })
  )
  if (result.outcome === 'fenced') {
    return result.cutover
  }
  if (result.blockers?.length) {
    // Surface blocked state in logs because connect shows only the summary reason.
    console.warn(
      '[ssh] Conversion refused by:',
      JSON.stringify(
        result.blockers.map((blocker) =>
          'dependencies' in blocker
            ? { code: blocker.code, dependencies: blocker.dependencies }
            : { code: blocker.code }
        )
      )
    )
  }
  const leavable =
    result.blockers &&
    onlyLeavableHivewarddMigrationBlockers(result.blockers) &&
    !target.managedServerLeaveBehind
  const canLeaveBehind =
    leavable &&
    leaveBehindClearsHivewarddMigrationBlockers(
      store,
      target.id,
      terminalProof.verdict === 'bridged' ? terminalProof.bridgedPtyIds : [],
      args.isBridgedPaneLease
    )
  if (leavable && terminalProof.verdict !== 'exited' && !canLeaveBehind) {
    // Leaving tabs behind would strand terminals still served by the legacy bridge.
    return refuse(
      result.verdict,
      result.code,
      `${result.reason} ${HIVEWARDD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON}`
    )
  }
  return {
    ...refuse(result.verdict, result.code, result.reason),
    // Preview confirmation to avoid offering an export the confirmed path would refuse.
    ...(canLeaveBehind ? { canLeaveBehind: true } : {})
  }
}

function requireJournaledCutover(
  userDataPath: string,
  fenced: HivewarddMigrationSourceCutover
): HivewarddMigrationSourceCutover {
  const journaled = findHivewarddMigrationSourceCutoverForTarget(userDataPath, fenced.sshTargetId)
  if (journaled?.migrationId !== fenced.migrationId) {
    throw new Error('hivewardd_migration_source_fence_lost')
  }
  return journaled
}

function isRegistered(userDataPath: string, environmentId: string): boolean {
  return listEnvironments(userDataPath).some((environment) => environment.id === environmentId)
}

function refuse(
  verdict: 'live' | 'unverifiable',
  code: string,
  reason: string
): Extract<HivewarddManagedConversionResult, { outcome: 'refused' }> {
  return { outcome: 'refused', verdict, code, reason }
}
