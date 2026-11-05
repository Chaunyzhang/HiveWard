import {
  cancelManagedHivewarddStop,
  forgetManagedHivewarddEnvironment,
  stopManagedHivewarddEnvironment
} from '../../managed-server/lifecycle/hivewardd-runtime-decommission'
import { getManagedHivewarddRuntimeStatus } from '../../managed-server/lifecycle/hivewardd-runtime-status'
import {
  recoverManagedHivewarddEnvironment,
  rollbackManagedHivewarddEnvironment,
  updateManagedHivewarddEnvironment
} from '../../ssh/hivewardd-runtime-maintenance'
import { getHivewarddSshDeployment } from '../../../shared/runtime-environments'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type {
  HivewarddManagedRestartResult,
  HivewarddManagedStaleLockReclaimRequest,
  HivewarddManagedStaleLockReclaimResult
} from '../../../shared/hivewardd-managed-runtime'
import { restartManagedHivewarddEnvironment } from '../../managed-server/lifecycle/hivewardd-managed-launch-session'
import { runManagedHivewarddStaleLockReclaim } from '../../managed-server/lifecycle/hivewardd-managed-stale-lock-reclaim'
import { clearLaunchSessionNote } from './runtime-environment-managed-tunnel'
import { forgetLaunchSessionVerdict } from '../ssh/ssh-host-launch-session-note'
import type { ManagedServerActions } from '../../runtime/managed-server-actions-registry'
import {
  retireRemovedRuntimeEnvironment,
  type RemovedServerStore
} from './runtime-environment-removal-cleanup'

export type ManagedHivewarddActionOptions = {
  getUserDataPath: () => string
  getActiveEnvironmentId: () => string | null | undefined
  invalidateTransport: (environmentId: string) => Promise<void> | void
  clearHostServerNotes: (sshTargetId: string, environmentId: string) => void
  clearHostServerStatus: (sshTargetId: string) => void
  store: RemovedServerStore
}

export function createManagedHivewarddActions(
  options: ManagedHivewarddActionOptions
): ManagedServerActions {
  const userDataPath = options.getUserDataPath
  const unlinkPolicy = {
    isActiveEnvironment: (environmentId: string) =>
      options.getActiveEnvironmentId() === environmentId,
    retireLocalState: (environmentId: string) =>
      retireRemovedRuntimeEnvironment(
        environmentId,
        options.invalidateTransport,
        options.store,
        userDataPath()
      )
  }
  return {
    status: (selector) => getManagedHivewarddRuntimeStatus(userDataPath(), selector),
    update: async (selector, force, pastLiveTerminals) => {
      const result = await updateManagedHivewarddEnvironment(userDataPath(), {
        selector,
        force,
        ...(pastLiveTerminals ? { pastLiveTerminals } : {})
      })
      if (result.outcome === 'updated') {
        await options.invalidateTransport(result.environment.id)
      }
      if (result.outcome !== 'deferred') {
        const targetId = getHivewarddSshDeployment(result.environment)?.sshTargetId
        if (targetId) {
          options.clearHostServerNotes(targetId, result.environment.id)
        }
      }
      return result
    },
    rollback: async (selector) => {
      const result = await rollbackManagedHivewarddEnvironment(userDataPath(), { selector })
      if (result.outcome === 'rolled-back') {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    },
    recover: async (selector, acceptChangedState) => {
      const result = await recoverManagedHivewarddEnvironment(userDataPath(), {
        selector,
        acceptChangedState: acceptChangedState === true
      })
      if (result.outcome === 'recovered' && result.activeVersion) {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    },
    stop: async (selector) => {
      const result = await stopManagedHivewarddEnvironment(userDataPath(), { selector }, unlinkPolicy)
      if (result.outcome === 'unlinked') {
        options.clearHostServerStatus(result.sshTargetId)
      }
      return result
    },
    cancelStop: (selector) => cancelManagedHivewarddStop(userDataPath(), { selector }),
    forget: async (selector) => {
      const result = await forgetManagedHivewarddEnvironment(userDataPath(), { selector }, unlinkPolicy)
      if (result.outcome === 'forgotten') {
        options.clearHostServerStatus(result.sshTargetId)
      }
      return result
    }
  }
}

export async function restartManagedHivewardd(
  options: ManagedHivewarddActionOptions,
  selector: string
): Promise<HivewarddManagedRestartResult> {
  const result = await restartManagedHivewarddEnvironment(options.getUserDataPath(), selector)
  if (result.outcome === 'restarted') {
    await reconnectRestartedManagedHivewardd(options, result.environmentId)
  }
  return result
}

export async function reclaimManagedHivewarddStaleLock(
  options: ManagedHivewarddActionOptions,
  selector: string,
  request: HivewarddManagedStaleLockReclaimRequest
): Promise<HivewarddManagedStaleLockReclaimResult> {
  const result = await runManagedHivewarddStaleLockReclaim(options.getUserDataPath(), selector, request)
  // Reconnect also replaces stale-lock feedback when no process had started.
  if (result.status === 'reclaimed') {
    await reconnectRestartedManagedHivewardd(options, result.environmentId)
  }
  return result
}

async function reconnectRestartedManagedHivewardd(
  options: ManagedHivewarddActionOptions,
  environmentId: string
): Promise<void> {
  await options.invalidateTransport(environmentId)
  const environment = resolveEnvironment(options.getUserDataPath(), environmentId)
  const targetId = getHivewarddSshDeployment(environment)?.sshTargetId
  if (targetId) {
    options.clearHostServerNotes(targetId, environmentId)
    forgetLaunchSessionVerdict(targetId)
    clearLaunchSessionNote(targetId, environmentId)
  }
}
