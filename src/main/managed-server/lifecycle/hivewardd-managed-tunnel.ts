import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { probeManagedHivewarddTunnel } from './hivewardd-managed-tunnel-resume'
import { ensureManagedHivewarddServing } from './hivewardd-managed-serving'
import { HivewarddManagedTunnelManager } from './hivewardd-managed-tunnel-manager'
import { buildOnBindableLocalPort } from './hivewardd-managed-tunnel-local-port'
import { getRemoteRuntimeSharedControlAnsweredAt } from '../../ipc/runtime-environments/runtime-environment-shared-control-answers'
import {
  getSshConnectionManager,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import {
  MANAGED_HIVEWARDD_TUNNEL_TARGETING,
  type HivewarddTunnelStartChecks
} from './hivewardd-managed-tunnel-target'
import {
  liveManagedHivewarddPairingRepairDeps,
  ManagedHivewarddPairingRepairs,
  pairingRevisionOf
} from './hivewardd-managed-pairing-repair'
import {
  buildWithPairingRepair,
  type ManagedHivewarddPairingRecovery
} from './hivewardd-managed-tunnel-pairing-recovery'

const managedTunnels = new HivewarddManagedTunnelManager({
  getConnectionManager: getSshConnectionManager,
  getTargetStore: getSshTargetRegistryStore,
  targeting: MANAGED_HIVEWARDD_TUNNEL_TARGETING,
  ensureServing: (input) =>
    ensureManagedHivewarddServing({
      ...input,
      probe: probeManagedHivewarddTunnel,
      answeredAt: getRemoteRuntimeSharedControlAnsweredAt
    })
})

const pairingRepairs = new Map<string, ManagedHivewarddPairingRepairs>()

function pairingRecovery(userDataPath: string): ManagedHivewarddPairingRecovery {
  let repairs = pairingRepairs.get(userDataPath)
  if (!repairs) {
    repairs = new ManagedHivewarddPairingRepairs(liveManagedHivewarddPairingRepairDeps(userDataPath))
    pairingRepairs.set(userDataPath, repairs)
  }
  return {
    resolve: (environmentId) => resolveEnvironment(userDataPath, environmentId),
    repairs,
    ensure: (environment) =>
      managedTunnels.ensure(environment, () =>
        resolveEnvironmentOrNull(userDataPath, environment.id)
      )
  }
}

/** Return stored credentials: tunnel repair may have replaced the pairing. */
export async function ensureHivewarddManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<KnownRuntimeEnvironment> {
  const { id } = resolveEnvironment(userDataPath, selector)
  await buildOnBindableLocalPort(userDataPath, id, () =>
    buildWithPairingRepair(pairingRecovery(userDataPath), id, (environment) =>
      managedTunnels.ensure(environment, () => resolveEnvironmentOrNull(userDataPath, id))
    )
  )
  return resolveEnvironment(userDataPath, id)
}

export async function rebuildHivewarddManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<'built' | 'repaired'> {
  const { id } = resolveEnvironment(userDataPath, selector)
  return buildOnBindableLocalPort(userDataPath, id, () =>
    buildWithPairingRepair(pairingRecovery(userDataPath), id, (environment) =>
      managedTunnels.rebuild(environment, () => resolveEnvironmentOrNull(userDataPath, id))
    )
  )
}

/** Reprove pinned-server refusal before repair; foreign servers must fail identity validation. */
export function recoverRefusedManagedHivewarddPairing(
  userDataPath: string,
  environmentId: string
): Promise<'built' | 'repaired'> {
  return rebuildHivewarddManagedTunnel(userDataPath, environmentId)
}

/** Ignore failures belonging to older pairing revisions. */
export function managedHivewarddPairingFailureStands(
  userDataPath: string,
  environmentId: string
): boolean {
  const environment = resolveEnvironmentOrNull(userDataPath, environmentId)
  return (
    environment !== null &&
    (pairingRepairs
      .get(userDataPath)
      ?.standingFailure(environmentId, pairingRevisionOf(environment)) ?? null) !== null
  )
}

/** Explicit connect clears recent repair failures. */
export function forgetFailedManagedHivewarddPairingRepair(
  userDataPath: string,
  environmentId: string
): void {
  pairingRepairs.get(userDataPath)?.forgetFailures(environmentId)
}

function resolveEnvironmentOrNull(userDataPath: string, id: string) {
  try {
    return resolveEnvironment(userDataPath, id)
  } catch {
    return null
  }
}

export function verifyManagedTunnelServing(environment: KnownRuntimeEnvironment) {
  return managedTunnels.verifyServing(environment)
}

export function disposeHivewarddManagedTunnels(): void {
  managedTunnels.dispose()
}

// System SSH forwards have independent processes and can outlive HiveWard.
export function shutdownHivewarddManagedTunnels(): Promise<void> {
  return managedTunnels.shutdown()
}

export function recoverHivewarddManagedTunnelsAfterHostResume(
  userDataPath: string,
  options: { attempts: number; timeoutMs: number }
): Promise<void> {
  return managedTunnels.recoverAfterHostResume({
    ...options,
    resolveEnvironment: (environmentId) => resolveEnvironmentOrNull(userDataPath, environmentId)
  })
}

export function startHivewarddManagedTunnel(
  environmentId: string,
  target: SshTarget,
  connection: SshConnection,
  remotePort: number,
  checks?: HivewarddTunnelStartChecks
): Promise<number> {
  return managedTunnels.start(environmentId, target, connection, remotePort, checks)
}

export function closeHivewarddManagedTunnel(environmentId: string): Promise<void> {
  return managedTunnels.close(environmentId)
}

export function closeHivewarddManagedTunnelsForTarget(targetId: string): Promise<void> {
  return managedTunnels.closeTarget(targetId)
}
