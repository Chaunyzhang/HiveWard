import { encodePairingOffer } from '../../../shared/pairing'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { disconnectRegisteredSshTarget } from '../../ipc/ssh/ssh-session-teardown'
import type { HivewarddMigrationDestinationCatalog } from '../../ssh/hivewardd-migration-cutover-coordinator'
import {
  abortRemoteHivewarddMigrationCatalog,
  commitRemoteHivewarddMigrationCatalog,
  listRemoteHivewarddRepositories,
  readRemoteHivewarddMigrationCatalogState,
  stageRemoteHivewarddMigrationCatalog,
  stageRemoteHivewarddMigrationSnapshotChunk
} from '../../ssh/hivewardd-migration-catalog-client'
import { abortRemoteHivewarddMigrationCatalogByReference } from '../../ssh/hivewardd-migration-catalog-reference-client'
import {
  enableRemoteHivewarddAutomation,
  type EnableServerAutomation
} from '../../ssh/hivewardd-migration-moved-automations'
import { censusHostRelayTerminalsFor } from '../../ssh/legacy-relay/ssh-host-relay-census-for-target'
import { isBridgeableLease } from '../../ssh/legacy-relay/legacy-relay-bridge-leases'
import type { HivewarddManagedConversionArgs } from './hivewardd-runtime-conversion'
import type { HivewarddServerRepository } from '../../ssh/hivewardd-migration-repository-link'
import {
  listRemoteHivewarddFolderCatalog,
  type HivewarddServerFolderCatalog
} from '../../ssh/hivewardd-server-folder-workspaces'

export function hivewarddMigrationDestinationFor(
  environment: KnownRuntimeEnvironment
): HivewarddMigrationDestinationCatalog {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  const options = environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  return {
    readState: (manifest) => readRemoteHivewarddMigrationCatalogState(pairingCode, manifest, options),
    stage: (manifest) => stageRemoteHivewarddMigrationCatalog(pairingCode, manifest, options),
    commit: (manifest) => commitRemoteHivewarddMigrationCatalog(pairingCode, manifest, options),
    abort: (manifest) => abortRemoteHivewarddMigrationCatalog(pairingCode, manifest, options),
    abortByReference: (manifest) =>
      abortRemoteHivewarddMigrationCatalogByReference(pairingCode, manifest, options),
    stageChunk: (request) => stageRemoteHivewarddMigrationSnapshotChunk(pairingCode, request, options)
  }
}

export function hivewarddServerRepositoriesFor(
  environment: KnownRuntimeEnvironment
): Promise<HivewarddServerRepository[]> {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  return listRemoteHivewarddRepositories(
    pairingCode,
    environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  )
}

export function hivewarddServerFolderCatalogFor(
  environment: KnownRuntimeEnvironment
): Promise<HivewarddServerFolderCatalog> {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  return listRemoteHivewarddFolderCatalog(
    pairingCode,
    environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  )
}

export function hivewarddServerAutomationEnablerFor(
  environment: KnownRuntimeEnvironment
): EnableServerAutomation {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  const options = environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  return (automation) => enableRemoteHivewarddAutomation(pairingCode, automation, options)
}

export function conversionCollaborators(): Pick<
  HivewarddManagedConversionArgs,
  | 'destinationFor'
  | 'serverRepositoriesFor'
  | 'serverFolderCatalogFor'
  | 'serverAutomationEnablerFor'
  | 'censusHost'
  | 'isBridgedPaneLease'
  | 'releaseDirectSession'
> {
  return {
    destinationFor: hivewarddMigrationDestinationFor,
    serverRepositoriesFor: hivewarddServerRepositoriesFor,
    serverFolderCatalogFor: hivewarddServerFolderCatalogFor,
    serverAutomationEnablerFor: hivewarddServerAutomationEnablerFor,
    censusHost: (target) => censusHostRelayTerminalsFor(target)(),
    isBridgedPaneLease: isBridgeableLease,
    releaseDirectSession: disconnectRegisteredSshTarget
  }
}
