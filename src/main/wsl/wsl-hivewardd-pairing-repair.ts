/** Use the managed SSH repair gate for refused WSL enrollment: serialize, cap attempts and require the pinned host key. Read new offers inside the local distro. */
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import {
  findWslHostDeployment,
  refreshWslHostPairing
} from '../../shared/runtime-environment-wsl-host-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { readActiveManagedHivewarddReadiness } from '../managed-server/lifecycle/hivewardd-managed-bound-port'
import {
  ManagedHivewarddPairingRepairs,
  type ManagedHivewarddPairingRepairDeps
} from '../managed-server/lifecycle/hivewardd-managed-pairing-repair'
import type { WslHivewarddHostTransport } from './wsl-hivewardd-host-transport'
import { HivewarddManagedPairingRepairFailedError } from '../managed-server/lifecycle/hivewardd-managed-pairing-repair-failure'
import { notifyManagedHivewarddPairingRepaired } from '../managed-server/lifecycle/hivewardd-managed-pairing-repaired-listener'
import type { WslHivewarddHostTarget } from './wsl-hivewardd-host-target'
import { createWslHivewarddHostTransport } from './wsl-hivewardd-host-transport'
import type { WslHivewarddPairingRecovery } from './wsl-hivewardd-pairing-identity'

type WslHivewarddHostAccess = { target: WslHivewarddHostTarget; connection: WslHivewarddHostTransport }

export function liveWslHivewarddPairingRepairDeps(
  userDataPath: string
): ManagedHivewarddPairingRepairDeps<WslHivewarddHostAccess> {
  const record = (environmentId: string) => {
    const found = findWslHostDeployment(userDataPath, environmentId)
    if (!found) {
      throw new HivewarddManagedPairingRepairFailedError('this server is not a WSL host')
    }
    return found
  }
  return {
    resolve: (environmentId) => resolveEnvironment(userDataPath, environmentId),
    connect: async (environment: KnownRuntimeEnvironment) => {
      const target: WslHivewarddHostTarget = {
        kind: 'wsl',
        id: environment.id,
        distro: record(environment.id).distro,
        label: environment.name
      }
      return { target, connection: createWslHivewarddHostTransport({ target }) }
    },
    readReadiness: async (access) => {
      try {
        return await readActiveManagedHivewarddReadiness(access)
      } finally {
        access.connection.dispose()
      }
    },
    ports: (environment) => {
      const found = findWslHostDeployment(userDataPath, environment.id)
      return found ? { localPort: found.localPort, remotePort: found.remotePort } : null
    },
    refresh: (environmentId, pairingCode) => {
      const { localPort, remotePort } = record(environmentId)
      return refreshWslHostPairing(userDataPath, environmentId, {
        pairingCode,
        localPort,
        remotePort
      }).environment
    },
    repaired: notifyManagedHivewarddPairingRepaired,
    now: Date.now
  }
}

/** One gate per desktop, so the cap and a standing failure hold across every WSL connect. */
export function createWslHivewarddPairingRecovery(
  userDataPath: string,
  deps: ManagedHivewarddPairingRepairDeps<WslHivewarddHostAccess> = liveWslHivewarddPairingRepairDeps(
    userDataPath
  )
): Omit<WslHivewarddPairingRecovery, 'environmentId'> {
  return { repairs: new ManagedHivewarddPairingRepairs(deps), resolve: deps.resolve }
}
