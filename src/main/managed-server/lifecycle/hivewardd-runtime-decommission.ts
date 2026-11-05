// Keep claims, tunnels and registration until the host proves server exit.
import type {
  HivewarddManagedCancelStopResult,
  HivewarddManagedForgetResult,
  HivewarddManagedStopResult
} from '../../../shared/hivewardd-managed-runtime'
import type { HivewarddDaemonRetirementVerdict } from '../../../shared/hivewardd-stop-request'
import { removeManagedHivewarddEnvironment } from '../../../shared/runtime-environment-managed-hivewardd-store'
import type {
  KnownRuntimeEnvironment,
  HivewarddSshDeploymentLink
} from '../../../shared/runtime-environments'
import { recoverInterruptedHivewarddActivation } from '../activation/hivewardd-activation-recovery'
import { withStaleHivewarddActivationRecoveryLock } from '../activation/hivewardd-activation-lock'
import { readHivewarddActivationTransaction } from '../activation/hivewardd-activation-transaction-store'
import { reconcileHivewarddDecommission } from './hivewardd-decommission-recovery'
import { cancelRemoteHivewarddManagedStop } from './hivewardd-managed-remote-stop'
import {
  managedHivewarddSlot,
  requireManagedHivewarddInfrastructure,
  resolveLinkedHivewarddContext
} from './hivewardd-managed-runtime-context'
import { closeHivewarddManagedTunnel, ensureHivewarddManagedTunnel } from './hivewardd-managed-tunnel'
import { clearManagedHivewarddUpdateDeferral } from './hivewardd-managed-update-deferrals'
import { removeHivewarddMigrationJournalsForDestination } from '../../ssh/hivewardd-migration-cutover-journal'
import { decommissionRemoteHivewardd } from '../install/hivewardd-remote-decommission'
import { withManagedHivewarddLifecycle } from '../../ssh/hivewardd-runtime-maintenance'
import { collectManagedTerminalCensus } from '../../ssh/hivewardd-terminal-census-client'
import { RemoteInstallLockBusyError } from '../install/remote-install-lock'

type ManagedHivewarddStopPolicy = {
  isActiveEnvironment: (environmentId: string) => boolean
  retireLocalState: (environmentId: string) => Promise<void> | void
}

type Refusal = Extract<HivewarddManagedStopResult, { outcome: 'refused' }>
type Stopped = { version: string | null; retirement: HivewarddDaemonRetirementVerdict | null }

function refuse(verdict: Refusal['verdict'], code: string, reason: string): Refusal {
  return { outcome: 'refused', verdict, code, reason }
}

export function stopManagedHivewarddEnvironment(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal },
  policy: ManagedHivewarddStopPolicy
): Promise<HivewarddManagedStopResult> {
  return withManagedHivewarddLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    if (policy.isActiveEnvironment(environment.id)) {
      return refuse(
        'live',
        'hivewardd_stop_active_environment',
        'This server is the default host for new projects. Choose another one under New projects open on before stopping it.'
      )
    }
    const stopped = await stopRemote(userDataPath, environment, deployment, args.signal)
    if ('outcome' in stopped) {
      return stopped
    }
    await unlinkEnvironmentLocally(userDataPath, environment, deployment, policy)
    return {
      outcome: 'unlinked',
      verdict: 'exited',
      environmentId: environment.id,
      sshTargetId: deployment.sshTargetId,
      stoppedVersion: stopped.version,
      retirement: stopped.retirement
    }
  })
}

/** Forget local state without assuming host exit; later connects may relink a still-running server. */
export function forgetManagedHivewarddEnvironment(
  userDataPath: string,
  args: { selector: string },
  policy: ManagedHivewarddStopPolicy
): Promise<HivewarddManagedForgetResult> {
  return withManagedHivewarddLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    if (policy.isActiveEnvironment(environment.id)) {
      return refuse(
        'live',
        'hivewardd_forget_active_environment',
        'This server is the default host for new projects. Choose another one under New projects open on before forgetting it.'
      )
    }
    await unlinkEnvironmentLocally(userDataPath, environment, deployment, policy)
    return {
      outcome: 'forgotten',
      verdict: 'unverifiable',
      environmentId: environment.id,
      sshTargetId: deployment.sshTargetId
    }
  })
}

async function stopRemote(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  deployment: HivewarddSshDeploymentLink,
  signal?: AbortSignal,
  retried = false
): Promise<Stopped | Refusal> {
  const context = await resolveLinkedHivewarddContext(environment, deployment, signal)
  const slot = managedHivewarddSlot(context, deployment.remotePort, signal)
  const transaction = await readHivewarddActivationTransaction(slot)
  if (transaction?.operation === 'decommission') {
    // Resume the exact interrupted stop from its journal.
    const recovered = await recoverInterruptedHivewarddActivation(slot)
    if (recovered.outcome === 'recovered' && recovered.activeVersion === null) {
      return { version: transaction.activeVersion, retirement: null }
    }
    if (recovered.outcome === 'refused') {
      return refuse(recovered.verdict, recovered.code, recovered.reason)
    }
    if (recovered.outcome === 'pending') {
      return refuse('unverifiable', recovered.code, recovered.reason)
    }
    // Another run may settle recovery first; restart from its resulting record.
    if (recovered.outcome === 'none') {
      return retried
        ? refuse(
            'unverifiable',
            'hivewardd_stop_journal_changed',
            'Another run on this server changed its stop while this one waited. Refresh and retry.'
          )
        : stopRemote(userDataPath, environment, deployment, signal, true)
    }
    return refuse(
      'live',
      'hivewardd_stop_withdrawn',
      'The interrupted stop was withdrawn and the server keeps serving. Stop it again.'
    )
  }
  if (transaction) {
    return refuse(
      'unverifiable',
      'hivewardd_activation_recovery_required',
      'An earlier update on this server was interrupted. Recover it before stopping.'
    )
  }
  const record = context.activationRecord
  if (!record.active) {
    return { version: null, retirement: null }
  }
  const census = await collectManagedTerminalCensus(userDataPath, environment, record)
  const result = await decommissionRemoteHivewardd({ ...slot, record, census })
  if (result.outcome === 'refused') {
    return refuse(result.verdict, result.code, result.reason)
  }
  return { version: result.version, retirement: result.retirement }
}

async function unlinkEnvironmentLocally(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  deployment: HivewarddSshDeploymentLink,
  policy: ManagedHivewarddStopPolicy
): Promise<void> {
  // Remove registration before releasing claims so crashes leave a resumable hidden target.
  removeManagedHivewarddEnvironment(userDataPath, environment.id)
  await policy.retireLocalState(environment.id)
  await closeHivewarddManagedTunnel(environment.id)
  const { claims } = requireManagedHivewarddInfrastructure()
  claims.releaseForUserRemoval(deployment.sshTargetId, environment.id)
  clearManagedHivewarddUpdateDeferral(environment.id)
  await claims.flush()
  // Clear journals after the fence; stale leftovers are recoverable on later conversion.
  removeHivewarddMigrationJournalsForDestination(userDataPath, deployment.sshTargetId, environment.id)
}

export function cancelManagedHivewarddStop(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal }
): Promise<HivewarddManagedCancelStopResult> {
  return withManagedHivewarddLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    const context = await resolveLinkedHivewarddContext(environment, deployment, args.signal)
    const slot = managedHivewarddSlot(context, deployment.remotePort, args.signal)
    let result: HivewarddManagedCancelStopResult
    try {
      result = await withStaleHivewarddActivationRecoveryLock(slot, async (lock) => {
        const transaction = await readHivewarddActivationTransaction(slot)
        if (transaction?.operation !== 'decommission') {
          if (transaction) {
            lock.retain()
          }
          return { outcome: 'none' }
        }
        if (transaction.phase === 'process-exited') {
          lock.retain()
          return { outcome: 'already-stopped' }
        }
        if (transaction.request) {
          const cancellation = await cancelRemoteHivewarddManagedStop(slot, transaction.request)
          if (cancellation.outcome !== 'canceled') {
            lock.retain()
            return {
              outcome: 'refused',
              verdict: 'live',
              code: 'hivewardd_stop_already_dispatched',
              reason: 'hivewardd already acted on the stop and is shutting down; it cannot be canceled.'
            }
          }
        }
        const kept = await reconcileHivewarddDecommission(slot, {
          action: 'keep-serving',
          version: transaction.activeVersion
        })
        if (kept.outcome !== 'recovered' || !kept.activeVersion) {
          lock.retain()
          return {
            outcome: 'refused',
            verdict: 'unverifiable',
            code: 'hivewardd_stop_cancel_unverifiable',
            reason: 'The stop was withdrawn but the server could not be shown to be serving.'
          }
        }
        return { outcome: 'canceled', activeVersion: kept.activeVersion }
      })
    } catch (error) {
      if (error instanceof RemoteInstallLockBusyError) {
        return {
          outcome: 'refused',
          verdict: 'unverifiable',
          code: 'hivewardd_stop_still_running',
          reason: 'A stop on this server may still be running. Retry after it settles.'
        }
      }
      throw error
    }
    if (result.outcome === 'canceled') {
      await ensureHivewarddManagedTunnel(userDataPath, environment.id)
    }
    return result
  })
}
