import { getAppEnvironment } from '../../../shared/app-environment'
import {
  getManagedHivewarddFenceEnvironmentId,
  managedHivewarddServerName
} from '../../../shared/managed-hivewardd-ssh-owner'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { findHivewarddMigrationSourceCutoverForTarget } from '../../ssh/hivewardd-migration-cutover-journal'
import { abandonHivewarddConversion } from '../../ssh/hivewardd-conversion-abandon'
import { retainHivewarddMigrationSource } from '../../ssh/hivewardd-migration-source-retention'
import { enableMovedHivewarddAutomationsForTarget } from '../../ssh/hivewardd-migration-moved-automations'
import { hasHivewarddTemplate } from '../../hivewardd/hivewardd-artifact-materializer'
import { isHivewarddHostUnavailableFixableOnHost } from '../../hivewardd/hivewardd-host-unavailable'
import { managedServerUpdateDeps } from '../../ssh/managed-server-update-deps'
import { ensureHivewarddManagedTunnel } from '../../managed-server/lifecycle/hivewardd-managed-tunnel'
import { verifyHivewarddManagedServing } from '../../managed-server/lifecycle/hivewardd-managed-serving-verify'
import { convertSshTargetToManagedHivewardd } from '../../managed-server/lifecycle/hivewardd-runtime-conversion'
import {
  hivewarddMigrationDestinationFor,
  hivewarddServerAutomationEnablerFor,
  hivewarddServerFolderCatalogFor,
  hivewarddServerRepositoriesFor
} from '../../managed-server/lifecycle/hivewardd-runtime-conversion-wiring'
import { createManagedHivewarddEnvironment } from '../../managed-server/lifecycle/hivewardd-runtime-deployment'
import type { HostServerOnConnectDeps } from '../../ssh/ssh-host-server-on-connect'
import {
  censusSshHostRelaysBeforeSession,
  relayTerminalsOnConnect
} from '../../ssh/legacy-relay/ssh-host-relay-terminals-on-connect'
import { requireManagedHivewarddInfrastructure } from '../../managed-server/lifecycle/hivewardd-managed-runtime-context'
import { censusHostRelayTerminalsFor } from '../../ssh/legacy-relay/ssh-host-relay-census-for-target'
import { setSshHostServerStatus } from '../../ssh/ssh-host-server-status'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { releaseUnreachableHivewarddSetup } from '../../ssh/hivewardd-unreachable-setup-release'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState } from './ssh-renderer-broadcast'
import { connectInFlight } from './ssh-connect-attempt-registry'
import { startLegacyRelayBridge } from '../../ssh/legacy-relay/legacy-relay-bridge-registry'
import { isBridgeableLease } from '../../ssh/legacy-relay/legacy-relay-bridge-leases'

export function hostServerOnConnectDeps(userDataPath: string): HostServerOnConnectDeps {
  const registry = getSshTargetRegistryStore()!
  const claims = registry.getHivewarddRuntimeClaims()
  const store = registry.getHivewarddMigrationSource()
  const appVersion = getAppEnvironment().getVersion()
  const isRegistered = (environmentId: string): boolean =>
    listEnvironments(userDataPath).some((entry) => entry.id === environmentId)
  return {
    // A fence alone may be unfinished setup; only registered servers count.
    managedEnvironmentId: (target) => {
      const environmentId = getManagedHivewarddFenceEnvironmentId(target)
      return environmentId && isRegistered(environmentId) ? environmentId : null
    },
    ensureTunnel: async (environmentId) => {
      await ensureHivewarddManagedTunnel(userDataPath, environmentId)
    },
    ensureServing: (environmentId) => verifyHivewarddManagedServing(userDataPath, environmentId),
    retainCommittedSource: async (target) => {
      const head = findHivewarddMigrationSourceCutoverForTarget(userDataPath, target.id)
      if (head?.phase !== 'destination-committed') {
        return 0
      }
      await retainHivewarddMigrationSource(userDataPath, head.migrationId, store)
      // Retry what earlier connects could not reach the server to re-enable.
      const environment = listEnvironments(userDataPath).find(
        (entry) => entry.id === head.destinationEnvironmentId
      )
      return environment
        ? enableMovedHivewarddAutomationsForTarget(
            userDataPath,
            target.id,
            hivewarddServerAutomationEnablerFor(environment)
          )
        : 0
    },
    hasTemplate: hasHivewarddTemplate,
    recordedUnavailable: (target) =>
      target.managedServerUnavailable?.appVersion === appVersion
        ? target.managedServerUnavailable.reason
        : null,
    recordUnavailable: (target, reason) => {
      if (!isHivewarddHostUnavailableFixableOnHost(reason)) {
        registry.updateTarget(target.id, { managedServerUnavailable: { reason, appVersion } })
      }
    },
    ...managedServerUpdateDeps(userDataPath),
    isEmptyHost: (target) => {
      // An interrupted empty-host deploy passes its own claim, recorded by its provisioning intent.
      const environmentId = getManagedHivewarddFenceEnvironmentId(target)
      return claims.preflight(
        target.id,
        environmentId
          ? { environmentId, recorded: target.hivewarddProvisioning !== undefined }
          : undefined
      ).claimable
    },
    relayTerminals: (target) =>
      relayTerminalsOnConnect({
        store,
        targetId: target.id,
        censusHost: async () =>
          censusSshHostRelaysBeforeSession(
            await requireManagedHivewarddInfrastructure().connectionManager.connect(target),
            target.id
          )
      }),
    deploy: (target) =>
      createManagedHivewarddEnvironment(userDataPath, {
        name: target.hivewarddProvisioning?.name ?? managedHivewarddServerName(target),
        sshTargetId: target.id
      }),
    convert: async (target, hostProof) => {
      // COMPAT(legacy-relay-bridge): find the panes old relays still run before the tabs remount.
      if (hostProof?.bridged) {
        await startLegacyRelayBridge(target.id)
      }
      const converted = await convertSshTargetToManagedHivewardd(userDataPath, {
        sshTargetId: target.id,
        name: managedHivewarddServerName(target),
        // The connect's own census already answered; a conversion before any session reuses it.
        censusHost: (host) =>
          hostProof ? Promise.resolve(hostProof) : censusHostRelayTerminalsFor(host)(),
        isBridgedPaneLease: isBridgeableLease,
        // Releasing the direct session here would cancel the connect that requested conversion.
        destinationFor: hivewarddMigrationDestinationFor,
        serverRepositoriesFor: hivewarddServerRepositoriesFor,
        serverFolderCatalogFor: hivewarddServerFolderCatalogFor,
        serverAutomationEnablerFor: hivewarddServerAutomationEnablerFor
      })
      if (converted.outcome === 'converted' || converted.outcome === 'refused') {
        // Move-anyway consent covers one attempt; retain it on failure so held-fence verification can resume.
        registry.updateTarget(target.id, { managedServerLeaveBehind: undefined })
      }
      return converted
    },
    abandonDeploy: async (target) => {
      const environmentId =
        getManagedHivewarddFenceEnvironmentId(target) ??
        getManagedHivewarddFenceEnvironmentId(registry.getTarget(target.id))
      if (environmentId && !isRegistered(environmentId)) {
        claims.release(target.id, environmentId)
        await claims.flush()
      }
    },
    hasUnfinishedConversion: (target) => {
      const head = findHivewarddMigrationSourceCutoverForTarget(userDataPath, target.id)
      return (
        head !== null &&
        !head.supersedesMigrationId &&
        (head.phase === 'source-fenced' || head.phase === 'destination-staged')
      )
    },
    abandonConversion: async (target) => {
      await abandonHivewarddConversion({
        userDataPath,
        store,
        claims,
        targetId: target.id,
        destinationFor: hivewarddMigrationDestinationFor
      })
    },
    isFencedBeforeStaging: (target) =>
      findHivewarddMigrationSourceCutoverForTarget(userDataPath, target.id)?.phase === 'source-fenced',
    releaseUnreachableSetup: (target) =>
      releaseUnreachableHivewarddSetup({ userDataPath, claims, targetId: target.id }),
    progress: (target, phase) => {
      // Cancelled decisions keep running; their progress must not revive connection status.
      if (!connectInFlight.has(target.id)) {
        return
      }
      setSshHostServerStatus(target.id, { kind: 'setting-up', phase })
      broadcastSshState(getCurrentMainWindow, target.id, {
        targetId: target.id,
        status: 'connecting',
        error: null,
        reconnectAttempt: 0
      })
    }
  }
}
