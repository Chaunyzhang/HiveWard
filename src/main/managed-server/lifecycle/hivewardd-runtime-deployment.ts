// Target claims preserve environment identity so interrupted deploys resume the same registration.
import { getAppEnvironment } from '../../../shared/app-environment'
import { randomUUID } from 'node:crypto'
import { assertRuntimeEnvironmentNotReconciling } from '../../../shared/runtime-environment-reconciliation-record'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { addManagedHivewarddEnvironment } from '../../../shared/runtime-environment-managed-hivewardd-store'
import {
  getHivewarddSshDeployment,
  redactRuntimeEnvironment
} from '../../../shared/runtime-environments'
import {
  HIVEWARDD_MANAGED_REMOTE_PORT,
  type HivewarddManagedDeferral,
  type HivewarddManagedDeployResult
} from '../../../shared/hivewardd-managed-runtime'
import { getManagedHivewarddFenceEnvironmentId } from '../../../shared/managed-hivewardd-ssh-owner'
import { runTargetLifecycle } from '../../ipc/ssh/ssh-target-lifecycle-queue'
import { materializeHivewarddArtifact } from '../../hivewardd/hivewardd-artifact-materializer'
import {
  closeHivewarddManagedTunnel,
  ensureHivewarddManagedTunnel,
  startHivewarddManagedTunnel
} from './hivewardd-managed-tunnel'
import { recoverInterruptedHivewarddActivation } from '../activation/hivewardd-activation-recovery'
import { wakeAlreadyActiveHivewardd } from '../../ssh/hivewardd-already-active-wake'
import { readHivewarddActivationRecord } from '../activation/hivewardd-activation-record-store'
import { resolveHivewarddRemoteContext, type HivewarddRemoteContext } from '../install/hivewardd-remote-context'
import { deployHivewardd } from '../../ssh/hivewardd-remote-deploy'
import {
  adoptRunningHivewarddVersion,
  type HivewarddRunningAdoption
} from '../../ssh/hivewardd-running-version-adoption'
import { readLocalFullVersion } from '../install/remote-versioned-install'
import { sshHivewarddHostTransport } from '../../ssh/hivewardd-ssh-host-transport'
import { HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE } from '../../ssh/hivewardd-installed-activation'
import { pruneManagedHivewarddVersions } from './hivewardd-managed-version-gc'
import { tunneledHivewarddPairingCode } from '../../ssh/hivewardd-tunneled-pairing'
import { resolveHivewarddMigrationFence } from '../../ssh/hivewardd-migration-source-fence'
import type { SshTarget } from '../../../shared/ssh-types'
import { findCollidingEnvironmentName } from '../../../shared/runtime-environment-name-collision'
import { deployedHivewarddTunnelChecks } from './hivewardd-managed-tunnel-identity'
import {
  isForceableHivewarddDeferral,
  managedHivewarddDeployPolicy,
  managedHivewarddSlot,
  probeManagedHivewarddReadiness,
  requireManagedHivewarddInfrastructure
} from './hivewardd-managed-runtime-context'

export async function createManagedHivewarddEnvironment(
  userDataPath: string,
  args: {
    name: string
    sshTargetId: string
    force?: boolean
    signal?: AbortSignal
    migration?: boolean
  }
): Promise<HivewarddManagedDeployResult> {
  return runTargetLifecycle(args.sshTargetId, async () => {
    const { connectionManager, targetStore, claims } = requireManagedHivewarddInfrastructure()
    const environmentId =
      getManagedHivewarddFenceEnvironmentId(targetStore.getTarget(args.sshTargetId)) ?? randomUUID()
    // Duplicate/name checks before an add: a crash-zeroed list (#18766) must read as empty here.
    const environments = listEnvironments(userDataPath, { recoverBlankStore: true })
    const registered = environments.find((entry) => entry.id === environmentId)
    if (registered) {
      assertRuntimeEnvironmentNotReconciling(registered)
      if (getHivewarddSshDeployment(registered)?.sshTargetId !== args.sshTargetId) {
        throw new Error('The SSH target is owned by a server that is not deployed on it.')
      }
    }
    const namesake = findCollidingEnvironmentName(
      environments.filter((entry) => entry.id !== environmentId),
      args.name
    )
    if (namesake) {
      throw new Error(`A server named "${namesake.name}" already exists.`)
    }
    const current = targetStore.getTarget(args.sshTargetId)
    if (args.migration) {
      assertMigrationFence(userDataPath, current, environmentId, args.name)
    }
    const claimed = claims.claim(args.sshTargetId, environmentId, {
      ...(args.migration ? {} : { deployName: args.name }),
      ownerRecorded:
        Boolean(args.migration) || Boolean(current?.hivewarddProvisioning) || Boolean(registered)
    })
    await claims.flush(args.signal)
    const targetGeneration = claimed.generation
    if (targetGeneration === undefined) {
      throw new Error(
        'The SSH registration for this host’s HiveWard server has no durable generation.'
      )
    }
    if (registered && getHivewarddSshDeployment(registered)?.sshTargetGeneration !== targetGeneration) {
      throw new Error('The saved HiveWard server for this host has a stale SSH target generation.')
    }
    let environmentRegistered = false
    try {
      const connection = await connectionManager.connect(claimed)
      let context = await resolveHivewarddRemoteContext(
        claimed,
        sshHivewarddHostTransport(connection),
        args.signal
      )
      const slot = managedHivewarddSlot(context, HIVEWARDD_MANAGED_REMOTE_PORT, args.signal)
      const recovery = await recoverInterruptedHivewarddActivation(slot)
      if (recovery.outcome === 'pending' || recovery.outcome === 'refused') {
        throw new Error(recovery.reason)
      }
      if (recovery.outcome === 'recovered') {
        context = { ...context, activationRecord: await readHivewarddActivationRecord(slot) }
      }
      if (registered) {
        environmentRegistered = true
        const current = await ensureHivewarddManagedTunnel(userDataPath, registered.id)
        const activeVersion = context.activationRecord.active
        if (!activeVersion) {
          throw new Error('This host’s HiveWard server has no active runtime version.')
        }
        return {
          outcome: 'already-current',
          environment: redactRuntimeEnvironment(current),
          activeVersion
        }
      }
      const localHivewarddDir = await materializeHivewarddArtifact(context.serverTarget, {
        signal: args.signal
      })
      // Adopt before upload: only the paired incumbent can count terminals; redeploy would defer.
      const localVersion = readLocalFullVersion(localHivewarddDir)
      const adopted = args.force
        ? null
        : await adoptRunningHivewarddVersion(slot, context.activationRecord, localVersion)
      const { active } = context.activationRecord
      if (!adopted && !args.force && active && active !== localVersion) {
        // Wake may observe a peer's changed record; census admission must use that same record.
        context = { ...context, activationRecord: await readHivewarddActivationRecord(slot) }
      }
      const serving: DeployedHivewardd | HivewarddManagedDeferral =
        adopted ??
        (await deployOwnHivewardd(context, { ...slot, conn: connection }, localHivewarddDir, args))
      if ('outcome' in serving) {
        return serving
      }
      // Read the bound port: the preferred port may belong to another host process.
      const tunnel = deployedHivewarddTunnelChecks(serving.readiness, serving.reprobe)
      const localPort = await startHivewarddManagedTunnel(
        environmentId,
        claimed,
        connection,
        tunnel.remotePort,
        { ...tunnel, preferredPort: HIVEWARDD_MANAGED_REMOTE_PORT }
      )
      const environment = addManagedHivewarddEnvironment(userDataPath, {
        id: environmentId,
        name: args.name,
        pairingCode: tunneledHivewarddPairingCode(tunnel.readiness(), localPort),
        hivewarddDeployment: {
          sshTargetId: claimed.id,
          sshTargetGeneration: targetGeneration,
          localPort,
          remotePort: HIVEWARDD_MANAGED_REMOTE_PORT
        }
      })
      environmentRegistered = true
      return {
        outcome: serving.created ? 'created' : 'already-current',
        environment: redactRuntimeEnvironment(environment),
        activeVersion: serving.version
      }
    } finally {
      if (!environmentRegistered) {
        await closeHivewarddManagedTunnel(environmentId).catch(() => undefined)
      }
    }
  })
}

type DeployedHivewardd = HivewarddRunningAdoption & { created?: true }

async function deployOwnHivewardd(
  context: HivewarddRemoteContext<SshTarget>,
  slot: ReturnType<typeof managedHivewarddSlot>,
  localHivewarddDir: string,
  args: { force?: boolean; signal?: AbortSignal }
): Promise<DeployedHivewardd | HivewarddManagedDeferral> {
  const appVersion = getAppEnvironment().getVersion()
  const deployResult = await deployHivewardd({
    ...slot,
    localHivewarddDir,
    target: context.serverTarget,
    ...managedHivewarddDeployPolicy(context, appVersion, args.force ? 'force' : 'connect'),
    force: args.force,
    appVersion
  })
  if (deployResult.outcome === 'installed-not-activated') {
    return {
      outcome: 'deferred',
      candidateVersion: deployResult.fullVersion,
      code: deployResult.code,
      reason: deployResult.reason,
      forceable:
        isForceableHivewarddDeferral(deployResult.code) ||
        deployResult.code === HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE
    }
  }
  if (deployResult.outcome === 'already-active') {
    await wakeAlreadyActiveHivewardd(slot)
  }
  const reprobe = () =>
    probeManagedHivewarddReadiness(context, localHivewarddDir, deployResult.fullVersion, args.signal)
  const readiness = await reprobe()
  await pruneManagedHivewarddVersions({
    slot,
    serverTarget: context.serverTarget,
    activeVersion: deployResult.fullVersion,
    readiness
  })
  return {
    version: deployResult.fullVersion,
    readiness,
    reprobe,
    ...(deployResult.outcome === 'already-active' ? {} : { created: true as const })
  }
}

function assertMigrationFence(
  userDataPath: string,
  target: SshTarget | undefined,
  environmentId: string,
  name: string
): void {
  const fence = target ? resolveHivewarddMigrationFence(userDataPath, target) : null
  if (
    fence?.state !== 'fenced' ||
    fence.cutover.destinationEnvironmentId !== environmentId ||
    fence.cutover.destinationName !== name
  ) {
    throw new Error('hivewardd_migration_fence_required')
  }
}
