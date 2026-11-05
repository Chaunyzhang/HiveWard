import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import { HIVEWARDD_UPDATE_TERMINALS_RUNNING_CODE } from '../../../shared/hivewardd-managed-runtime'
import {
  getHivewarddSshDeployment,
  type KnownRuntimeEnvironment,
  type HivewarddSshDeploymentLink
} from '../../../shared/runtime-environments'
import { getManagedHivewarddFenceEnvironmentId } from '../../../shared/managed-hivewardd-ssh-owner'
import type { ServeReadiness } from '../../server/serve-readiness'
import { computeLocalHivewarddBuildHash } from '../../ssh/hivewardd-local-build-hash'
import { sshHivewarddHostTransport } from '../../ssh/hivewardd-ssh-host-transport'
import type { HivewarddHostTarget } from '../../ssh/hivewardd-host-transport'
import type { HivewarddActivationRecord } from '../activation/hivewardd-activation-record'
import { admitHivewarddRecordForIntent, type HivewarddUpdateIntent } from './hivewardd-managed-update-decision'
import {
  type HivewarddTerminalCensus,
  UNVERIFIABLE_HIVEWARDD_TERMINAL_CENSUS
} from '../../../shared/hivewardd-terminal-census'
import { probeActiveHivewarddReadiness } from '../../ssh/hivewardd-active-readiness'
import { resolveHivewarddRemoteContext, type HivewarddRemoteContext } from '../install/hivewardd-remote-context'
import { HIVEWARDD_INSTALL_MODEL } from '../install/remote-install-model'
import { computeRemoteInstallDir } from '../install/remote-versioned-install'
import {
  getSshConnectionManager,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'

const HIVEWARDD_BIND_HOST = '127.0.0.1'

// Pinned slots must fail on absent markers rather than silently use host Node.
const MANAGED_HIVEWARDD_LEGACY_NODE_PATH = ''

export function requireManagedHivewarddInfrastructure() {
  const targetStore = requireManagedHivewarddTargetStore()
  const connectionManager = getSshConnectionManager()
  if (!connectionManager) {
    throw new Error(
      'SSH is unavailable on this client; this host’s HiveWard server is unverifiable.'
    )
  }
  return { connectionManager, targetStore, claims: targetStore.getHivewarddRuntimeClaims() }
}

export function requireManagedHivewarddTargetStore() {
  const targetStore = getSshTargetRegistryStore()
  if (!targetStore) {
    throw new Error('SSH target state is unavailable; this host’s HiveWard server is unverifiable.')
  }
  return targetStore
}

export function requireManagedHivewarddEnvironment(
  userDataPath: string,
  selector: string
): { environment: KnownRuntimeEnvironment; deployment: HivewarddSshDeploymentLink } {
  const environment = resolveEnvironment(userDataPath, selector)
  const deployment = getHivewarddSshDeployment(environment)
  if (!deployment || environment.connectionDependency !== 'ssh-tunnel') {
    throw new Error('This server is not managed through an hivewardd SSH deployment.')
  }
  return { environment, deployment }
}

export async function resolveLinkedHivewarddContext(
  environment: KnownRuntimeEnvironment,
  deployment: HivewarddSshDeploymentLink,
  signal?: AbortSignal
): Promise<HivewarddRemoteContext> {
  const { connectionManager, targetStore } = requireManagedHivewarddInfrastructure()
  const target = targetStore.getTarget(deployment.sshTargetId)
  if (
    !target ||
    target.generation !== deployment.sshTargetGeneration ||
    getManagedHivewarddFenceEnvironmentId(target) !== environment.id
  ) {
    throw new Error('The SSH registration for this host’s HiveWard server is no longer valid.')
  }
  const connection = await connectionManager.connect(target)
  return resolveHivewarddRemoteContext(target, sshHivewarddHostTransport(connection), signal)
}

export function managedHivewarddSlot(
  context: HivewarddRemoteContext<HivewarddHostTarget>,
  port: number,
  signal?: AbortSignal
) {
  return {
    conn: context.connection,
    host: context.host,
    remoteHome: context.remoteHome,
    nodePath: MANAGED_HIVEWARDD_LEGACY_NODE_PATH,
    userDataDir: context.userDataDir,
    bindHost: HIVEWARDD_BIND_HOST,
    port,
    signal
  }
}

export function managedHivewarddInstallDir(
  context: HivewarddRemoteContext<HivewarddHostTarget>,
  version: string
): string {
  return computeRemoteInstallDir(
    HIVEWARDD_INSTALL_MODEL,
    context.remoteHome,
    version,
    context.host.pathFlavor
  )
}

/** Accept readiness only from the build this client holds. */
export function probeManagedHivewarddReadiness(
  context: HivewarddRemoteContext<HivewarddHostTarget>,
  localHivewarddDir: string,
  fullVersion: string,
  signal?: AbortSignal
): Promise<ServeReadiness> {
  return probeActiveHivewarddReadiness(
    {
      conn: context.connection,
      host: context.host,
      remoteInstallDir: managedHivewarddInstallDir(context, fullVersion),
      signal
    },
    { buildHash: computeLocalHivewarddBuildHash(localHivewarddDir), fullVersion }
  )
}

export function managedHivewarddDeployPolicy(
  context: Pick<HivewarddRemoteContext<HivewarddHostTarget>, 'activationRecord'>,
  appVersion: string,
  intent: HivewarddUpdateIntent
): {
  census: HivewarddTerminalCensus
  recountCensus: () => Promise<HivewarddTerminalCensus>
  releaseIncumbentAdmission: () => Promise<void>
  censusRecord: HivewarddActivationRecord
  admitRecord: (record: HivewarddActivationRecord, candidateVersion: string) => string | null
} {
  // Only the active daemon can count sessions; guessing zero risks restarting live terminals.
  const census: HivewarddTerminalCensus = context.activationRecord.active
    ? UNVERIFIABLE_HIVEWARDD_TERMINAL_CENSUS
    : { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
  return {
    census,
    recountCensus: async () => census,
    releaseIncumbentAdmission: async () => {},
    censusRecord: context.activationRecord,
    // Only the fenced read can reject newer migrated state or rolled-back builds on this unlinked path.
    admitRecord: admitHivewarddRecordForIntent(intent, appVersion)
  }
}

// Force can override live terminal counts, never unknown census or protocol deferrals.
export function isForceableHivewarddDeferral(code: string): boolean {
  return code === HIVEWARDD_UPDATE_TERMINALS_RUNNING_CODE
}
