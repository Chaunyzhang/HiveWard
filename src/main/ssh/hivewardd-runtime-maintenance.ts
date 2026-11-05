/** Census through the managed tunnel before lifecycle changes. Unknown counts never mean zero, so live/uncounted hosts defer update (D7). */
import { getAppEnvironment } from '../../shared/app-environment'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type {
  HivewarddManagedDeployResult,
  HivewarddManagedPastLiveTerminals,
  HivewarddManagedRecoveryResult,
  HivewarddManagedRollbackResult
} from '../../shared/hivewardd-managed-runtime'
import { runTargetLifecycle } from '../ipc/ssh/ssh-target-lifecycle-queue'
import { recoverInterruptedHivewarddActivation } from '../managed-server/activation/hivewardd-activation-recovery'
import { probeActiveHivewarddReadiness } from './hivewardd-active-readiness'
import { materializeHivewarddArtifact } from '../hivewardd/hivewardd-artifact-materializer'
import { CURRENT_HIVEWARDD_DAEMON_PROTOCOL } from './hivewardd-daemon-protocol-crossing'
import { rebuildHivewarddManagedTunnel } from '../managed-server/lifecycle/hivewardd-managed-tunnel'
import { wakeAlreadyActiveHivewardd } from './hivewardd-already-active-wake'
import {
  clearManagedHivewarddUpdateDeferral,
  recordManagedHivewarddUpdateDeferral
} from '../managed-server/lifecycle/hivewardd-managed-update-deferrals'
import {
  isForceableHivewarddDeferral,
  managedHivewarddInstallDir,
  managedHivewarddSlot,
  probeManagedHivewarddReadiness,
  requireManagedHivewarddEnvironment,
  resolveLinkedHivewarddContext
} from '../managed-server/lifecycle/hivewardd-managed-runtime-context'
import type { HivewarddRemoteContext } from '../managed-server/install/hivewardd-remote-context'
import { readRemoteHivewarddBuildHash } from '../managed-server/install/hivewardd-remote-build-hash'
import { deployHivewardd, type HivewarddDeployOptions } from './hivewardd-remote-deploy'
import type { HivewarddUpdateForce } from './hivewardd-update-plan'
import { HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE } from './hivewardd-installed-activation'
import {
  pruneManagedHivewarddVersions,
  pruneSupersededHivewarddCandidates
} from '../managed-server/lifecycle/hivewardd-managed-version-gc'
import { clearHivewarddUpdateFailedThisLaunch } from '../managed-server/lifecycle/hivewardd-managed-update-failure-memory'
import { admitHivewarddRecordForIntent } from '../managed-server/lifecycle/hivewardd-managed-update-decision'
import { rollbackHivewardd } from '../managed-server/install/hivewardd-remote-rollback'
import { collectManagedTerminalCensus } from './hivewardd-terminal-census-client'
import { updateTerminalCounts } from './hivewardd-fenced-stop'
import { findIncompleteManagedHivewarddMigration } from '../managed-server/lifecycle/hivewardd-managed-migration-status'
import { latestHivewarddMigrationInto } from './hivewardd-migration-rollback-mark'
import { refreshMaintainedHivewarddPairing } from './hivewardd-maintenance-pairing-refresh'

type LifecycleArgs = { selector: string; signal?: AbortSignal }

export function withManagedHivewarddLifecycle<T>(
  userDataPath: string,
  selector: string,
  run: (managed: ReturnType<typeof requireManagedHivewarddEnvironment>) => Promise<T>
): Promise<T> {
  const { environment, deployment } = requireManagedHivewarddEnvironment(userDataPath, selector)
  return runTargetLifecycle(deployment.sshTargetId, async () => {
    // Re-read in the lifecycle queue because reconciliation/stop may have won first.
    const current = requireManagedHivewarddEnvironment(userDataPath, environment.id)
    assertRuntimeEnvironmentNotReconciling(current.environment)
    return run(current)
  })
}

/** Rebuild forwarding when a launched slot binds a different port. */
export async function followLaunchedServerPort(
  userDataPath: string,
  environmentId: string
): Promise<void> {
  try {
    await rebuildHivewarddManagedTunnel(userDataPath, environmentId)
  } catch (error) {
    // Server already launched; if tunnel rebuild fails, the next connect can forward its bound port.
    console.warn('[ssh] Could not forward to the relaunched managed HiveWard server:', error)
  }
}

export function updateManagedHivewarddEnvironment(
  userDataPath: string,
  args: LifecycleArgs & { force?: boolean; pastLiveTerminals?: HivewarddManagedPastLiveTerminals }
): Promise<HivewarddManagedDeployResult> {
  const { pastLiveTerminals } = args
  // Update anyway keeps Update's version admission even if a caller also passed force.
  const intent = args.force && !pastLiveTerminals ? 'force' : 'update'
  return withManagedHivewarddLifecycle(userDataPath, args.selector, async (managed) => {
    const admitIntent = admitHivewarddRecordForIntent(intent, getAppEnvironment().getVersion())
    // Checked under the host fence: another desktop may have activated a build since the confirm.
    const admitRecord: NonNullable<HivewarddDeployOptions['admitRecord']> = pastLiveTerminals
      ? (record, candidateVersion) =>
          record.active !== pastLiveTerminals.incumbentVersion
            ? "This host's server changed since the update was confirmed. Review it and update again."
            : admitIntent(record, candidateVersion)
      : admitIntent
    const force: HivewarddUpdateForce | undefined = pastLiveTerminals ? 'live-terminals' : args.force
    const result = await runManagedHivewarddUpdate(
      userDataPath,
      managed,
      await resolveLinkedHivewarddContext(managed.environment, managed.deployment, args.signal),
      { signal: args.signal, force, admitRecord }
    )
    // A completed manual update clears automatic failure suppression; deferred attempts do not.
    if (result.outcome !== 'deferred') {
      clearHivewarddUpdateFailedThisLaunch({ kind: 'ssh', id: managed.deployment.sshTargetId })
    }
    return result
  })
}

export async function runManagedHivewarddUpdate(
  userDataPath: string,
  { environment, deployment }: ReturnType<typeof requireManagedHivewarddEnvironment>,
  context: HivewarddRemoteContext,
  args: {
    force?: HivewarddUpdateForce
    signal?: AbortSignal
    localHivewarddDir?: string
    admitRecord?: HivewarddDeployOptions['admitRecord']
  }
): Promise<HivewarddManagedDeployResult> {
  const { countFirst, ...recount } = updateTerminalCounts((options) =>
    collectManagedTerminalCensus(
      userDataPath,
      environment,
      context.activationRecord,
      undefined,
      options
    )
  )
  const census = await countFirst()
  const localHivewarddDir =
    args.localHivewarddDir ??
    (await materializeHivewarddArtifact(context.serverTarget, { signal: args.signal }))
  const slot = managedHivewarddSlot(context, deployment.remotePort, args.signal)
  const result = await deployHivewardd({
    ...slot,
    localHivewarddDir,
    target: context.serverTarget,
    census,
    ...recount,
    censusRecord: context.activationRecord,
    force: args.force,
    appVersion: getAppEnvironment().getVersion(),
    ...(args.admitRecord ? { admitRecord: args.admitRecord } : {})
  })
  if (result.outcome === 'installed-not-activated') {
    const deferral = {
      outcome: 'deferred' as const,
      candidateVersion: result.fullVersion,
      code: result.code,
      reason: result.reason,
      // Force may override policy deferrals, including a newer host build.
      forceable:
        isForceableHivewarddDeferral(result.code) ||
        result.code === HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE
    }
    // Policy refusal is final for this host, not a transient update to retry.
    if (result.code !== HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE) {
      recordManagedHivewarddUpdateDeferral(environment.id, deferral)
    }
    await pruneSupersededHivewarddCandidates(slot, context.serverTarget, result.fullVersion)
    return deferral
  }
  clearManagedHivewarddUpdateDeferral(environment.id)
  const started = result.outcome === 'already-active' && (await wakeAlreadyActiveHivewardd(slot))
  const readiness = await probeManagedHivewarddReadiness(
    context,
    localHivewarddDir,
    result.fullVersion,
    args.signal
  )
  await pruneManagedHivewarddVersions({
    slot,
    serverTarget: context.serverTarget,
    activeVersion: result.fullVersion,
    readiness
  })
  const updated = refreshMaintainedHivewarddPairing(userDataPath, environment.id, readiness)
  if (started || result.outcome !== 'already-active') {
    await followLaunchedServerPort(userDataPath, environment.id)
  }
  return {
    outcome: result.outcome === 'already-active' ? 'already-current' : 'updated',
    environment: redactRuntimeEnvironment(updated),
    activeVersion: result.fullVersion
  }
}

export function rollbackManagedHivewarddEnvironment(
  userDataPath: string,
  args: LifecycleArgs
): Promise<HivewarddManagedRollbackResult> {
  return withManagedHivewarddLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedHivewarddContext(environment, deployment, args.signal)
      const record = context.activationRecord
      const target = record.previous
      if (!target) {
        return {
          outcome: 'refused',
          code: 'hivewardd_rollback_no_target',
          reason: 'This server has no previous version to roll back to.'
        }
      }
      const crossing = migrationRollbackRefusal(userDataPath, environment, record.activatedAt)
      if (crossing) {
        return crossing
      }
      const slot = managedHivewarddSlot(context, deployment.remotePort, args.signal)
      const targetDir = managedHivewarddInstallDir(context, target)
      const targetBuildHash = await readRemoteHivewarddBuildHash(slot, targetDir)
      const { countFirst, ...recount } = updateTerminalCounts((options) =>
        collectManagedTerminalCensus(userDataPath, environment, record, undefined, options)
      )
      // Recount under lock before rollback stop; this initial census closes no admission.
      const census = await countFirst()
      // Require idle because this client cannot prove the older build's daemon protocol attaches to live terminals.
      if (census.liveSessions !== 0) {
        return {
          outcome: 'refused',
          code:
            census.liveSessions === null
              ? 'hivewardd_rollback_census_unavailable'
              : 'hivewardd_rollback_terminals_running',
          reason:
            census.liveSessions === null
              ? 'The server did not answer how many terminals it runs. Retry when it answers.'
              : 'Close the terminals running on this server before rolling it back.'
        }
      }
      const result = await rollbackHivewardd({
        ...slot,
        record,
        census,
        ...recount,
        targetBuildHash,
        targetDaemonProtocol: CURRENT_HIVEWARDD_DAEMON_PROTOCOL
      })
      if (result.outcome !== 'rolled-back') {
        return result
      }
      const readiness = await probeActiveHivewarddReadiness(
        { ...slot, remoteInstallDir: targetDir },
        { buildHash: targetBuildHash, fullVersion: result.target }
      )
      const updated = refreshMaintainedHivewarddPairing(userDataPath, environment.id, readiness)
      await followLaunchedServerPort(userDataPath, environment.id)
      return {
        outcome: 'rolled-back',
        environment: redactRuntimeEnvironment(updated),
        activeVersion: result.target,
        discarded: result.discarded
      }
    }
  )
}

export function recoverManagedHivewarddEnvironment(
  userDataPath: string,
  args: LifecycleArgs & { acceptChangedState?: boolean }
): Promise<HivewarddManagedRecoveryResult> {
  return withManagedHivewarddLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedHivewarddContext(environment, deployment, args.signal)
      const result = await recoverInterruptedHivewarddActivation({
        ...managedHivewarddSlot(context, deployment.remotePort, args.signal),
        acceptChangedState: args.acceptChangedState === true
      })
      if (result.outcome !== 'recovered') {
        return result
      }
      const updated = result.readiness
        ? refreshMaintainedHivewarddPairing(userDataPath, environment.id, result.readiness)
        : environment
      if (result.activeVersion) {
        await followLaunchedServerPort(userDataPath, environment.id)
      }
      return {
        outcome: 'recovered',
        resolution: result.resolution,
        activeVersion: result.activeVersion,
        environment: redactRuntimeEnvironment(updated)
      }
    }
  )
}

/** A post-activation migration is absent from the rollback snapshot; restoring it would discard imported state. */
function migrationRollbackRefusal(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  activatedAt: string | null
): HivewarddManagedRollbackResult | null {
  if (findIncompleteManagedHivewarddMigration(userDataPath, environment.id)) {
    return {
      outcome: 'refused',
      code: 'hivewardd_rollback_migration_in_progress',
      reason: 'A migration into this server is still running. Finish it before rolling back.'
    }
  }
  const migratedAt = latestHivewarddMigrationInto(userDataPath, environment)
  if (migratedAt && (activatedAt === null || Date.parse(activatedAt) < Date.parse(migratedAt))) {
    return {
      outcome: 'refused',
      code: 'hivewardd_rollback_crosses_migration',
      reason:
        "The previous version's state predates the projects migrated onto this server; " +
        'rolling back would lose them. Deploy forward instead.'
    }
  }
  return null
}
