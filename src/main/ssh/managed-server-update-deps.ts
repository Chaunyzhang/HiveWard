import { getAppEnvironment } from '../../shared/app-environment'
import type { ManagedServerUpdateDeps } from './managed-server-update-check'
import { autoUpdateManagedHivewarddEnvironment } from '../managed-server/lifecycle/hivewardd-managed-auto-update'
import { requireManagedHivewarddTargetStore } from '../managed-server/lifecycle/hivewardd-managed-runtime-context'
import {
  hivewarddUpdateFailedThisLaunch,
  recordHivewarddUpdateFailedThisLaunch
} from '../managed-server/lifecycle/hivewardd-managed-update-failure-memory'

export function managedServerUpdateDeps(userDataPath: string): ManagedServerUpdateDeps {
  const registry = requireManagedHivewarddTargetStore()
  const appVersion = getAppEnvironment().getVersion()
  return {
    autoUpdate: (environmentId, options) =>
      autoUpdateManagedHivewarddEnvironment(userDataPath, { environmentId, appVersion, ...options }),
    // Re-read the store: caller snapshots may predate an overlapping check's failure.
    recordedUpdateFailure: (target) => {
      const failure = (registry.getTarget(target.id) ?? target).managedServerUpdateFailure
      return failure?.appVersion === appVersion ? failure.reason : null
    },
    // Only attempted failures suppress retry; keep launch-only state out of peer-published SshTarget.
    failedThisLaunch: (target) => hivewarddUpdateFailedThisLaunch({ kind: 'ssh', id: target.id }),
    recordUpdateFailure: (target, reason) => {
      recordHivewarddUpdateFailedThisLaunch(
        { kind: 'ssh', id: target.id },
        { code: 'hivewardd_update_failed', reason }
      )
      registry.updateTarget(target.id, { managedServerUpdateFailure: { reason, appVersion } })
    },
    clearUpdateFailure: (target) => {
      registry.updateTarget(target.id, { managedServerUpdateFailure: undefined })
    }
  }
}
