/** IPC for a host an older build changed after conversion: move its newer projects, or keep the server's. */
import { ipcMain } from 'electron'
import type {
  HivewarddDeltaMovePreview,
  HivewarddDeltaMoveResult
} from '../../../shared/hivewardd-managed-runtime'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { requireManagedHivewarddInfrastructure } from '../../managed-server/lifecycle/hivewardd-managed-runtime-context'
import { ensureHivewarddManagedTunnel } from '../../managed-server/lifecycle/hivewardd-managed-tunnel'
import { keepHivewarddServerVersion, runHivewarddDeltaMove } from '../../ssh/hivewardd-migration-delta-move'
import { planHivewarddDeltaMove } from '../../ssh/hivewardd-migration-delta-plan'
import { censusHostRelayTerminalsFor } from '../../ssh/legacy-relay/ssh-host-relay-census-for-target'
import {
  hivewarddMigrationDestinationFor,
  hivewarddServerAutomationEnablerFor
} from '../../managed-server/lifecycle/hivewardd-runtime-conversion-wiring'
import { enableMovedHivewarddAutomationsForTarget } from '../../ssh/hivewardd-migration-moved-automations'
import { requiredString } from './hivewardd-runtime-lifecycle-handlers'
import { publishResolvedChangedHostStatus } from './runtime-environment-managed-tunnel'
import { runTargetLifecycle } from '../ssh/ssh-target-lifecycle-queue'

export function registerHivewarddDeltaMoveHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:previewHivewarddDeltaMove',
    (_event, args: { sshTargetId: string }): HivewarddDeltaMovePreview => {
      const { store, target } = requireChangedHost(args)
      const plan = planHivewarddDeltaMove(getUserDataPath(), store, target)
      const { sshTargetId, environmentId, added, notReflected, blockers } = plan
      return { sshTargetId, environmentId, added, notReflected, blockers }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:moveHivewarddDelta',
    async (_event, args: { sshTargetId: string }): Promise<HivewarddDeltaMoveResult> => {
      const userDataPath = getUserDataPath()
      const { store, claims, target } = requireChangedHost(args)
      const environment = listEnvironments(userDataPath).find(
        (entry) => entry.id === target.hivewarddFence?.environmentId
      )
      if (!environment) {
        throw new Error('This host’s HiveWard server is no longer registered.')
      }
      const result = await runHivewarddDeltaMove({
        userDataPath,
        store,
        claims,
        target,
        environment,
        connectDestination: async () =>
          hivewarddMigrationDestinationFor(
            await ensureHivewarddManagedTunnel(userDataPath, environment.id)
          ),
        censusHost: censusHostRelayTerminalsFor(target),
        runTargetLifecycle
      })
      if (result.outcome === 'moved') {
        // Tunnel repair may have re-paired the server; read its current credentials.
        const paired = listEnvironments(userDataPath).find((entry) => entry.id === environment.id)
        const automationsLeftDisabled = await enableMovedHivewarddAutomationsForTarget(
          userDataPath,
          target.id,
          hivewarddServerAutomationEnablerFor(paired ?? environment)
        ).catch((error: unknown) => {
          console.warn('[ssh] Could not re-enable moved automations:', error)
          return 0
        })
        publishResolvedChangedHostStatus(target, environment.id, automationsLeftDisabled)
      }
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:keepHivewarddServerVersion',
    async (_event, args: { sshTargetId: string }): Promise<void> => {
      const { store, claims, target, environmentId } = requireChangedHost(args)
      await runTargetLifecycle(target.id, () =>
        keepHivewarddServerVersion({ userDataPath: getUserDataPath(), store, claims, target })
      )
      publishResolvedChangedHostStatus(target, environmentId)
    }
  )
}

function requireChangedHost(args: { sshTargetId: string } | undefined) {
  const sshTargetId = requiredString(args?.sshTargetId, 'SSH target')
  const { targetStore, claims } = requireManagedHivewarddInfrastructure()
  const store = targetStore.getHivewarddMigrationSource()
  const target = store.getSshTarget(sshTargetId)
  if (!target?.hivewarddFence?.sourceChangedAt) {
    throw new Error('This SSH host has no changes from an older HiveWard to resolve.')
  }
  return { store, claims, target, environmentId: target.hivewarddFence.environmentId }
}
