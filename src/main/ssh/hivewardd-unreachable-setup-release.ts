/** Release conversion setups stranded before staging by refused SSH forwarding. Stop any activated slot, unregister, then use undeployed-fence release; source rows remain intact for retry. */
import { listEnvironments } from '../../shared/runtime-environment-store'
import { removeManagedHivewarddEnvironment } from '../../shared/runtime-environment-managed-hivewardd-store'
import { findHivewarddMigrationSourceCutoverForTarget } from './hivewardd-migration-cutover-journal'
import { releaseUndeployedMigrationFence } from './hivewardd-migration-source-fence'
import { closeHivewarddManagedTunnel } from '../managed-server/lifecycle/hivewardd-managed-tunnel'
import type { SshTargetHivewarddClaims } from './targets/ssh-target-hivewardd-claims'
import { withHivewarddActivationLock } from '../managed-server/activation/hivewardd-activation-lock'
import { withDeactivatedVersionCommitted } from '../managed-server/activation/hivewardd-activation-record'
import {
  readHivewarddActivationRecord,
  writeHivewarddActivationRecord
} from '../managed-server/activation/hivewardd-activation-record-store'
import { managedHivewarddSlot } from '../managed-server/lifecycle/hivewardd-managed-runtime-context'
import { resolveHivewarddRemoteContext } from '../managed-server/install/hivewardd-remote-context'
import { hivewarddStopFreedTheHost } from '../managed-server/install/hivewardd-remote-process-control'
import { hivewarddSlotDir, stopHivewarddSlot } from './hivewardd-recovery-slot'
import { sshHivewarddHostTransport } from './hivewardd-ssh-host-transport'
import { getSshConnectionManager, getSshTargetRegistryStore } from './targets/ssh-target-registry'
import { errorMessage } from '../../shared/error-message'

export async function releaseUnreachableHivewarddSetup(args: {
  userDataPath: string
  claims: SshTargetHivewarddClaims
  targetId: string
  signal?: AbortSignal
}): Promise<void> {
  const cutover = findHivewarddMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  // Staged/committed destinations require their own evidence before release.
  if (cutover?.phase !== 'source-fenced') {
    return
  }
  const environmentId = cutover.destinationEnvironmentId
  await closeHivewarddManagedTunnel(environmentId).catch(() => undefined)
  await stopStrandedHivewardd(args.targetId, args.signal).catch((error: unknown) => {
    console.warn(`[hivewardd] Could not stop the unreachable setup's server: ${errorMessage(error)}`)
  })
  const isRegistered = (id: string): boolean =>
    listEnvironments(args.userDataPath).some((entry) => entry.id === id)
  // Unregister first so an interrupted release leaves a recoverable undeployed fence.
  if (isRegistered(environmentId)) {
    removeManagedHivewarddEnvironment(args.userDataPath, environmentId)
  }
  await releaseUndeployedMigrationFence({
    userDataPath: args.userDataPath,
    claims: args.claims,
    targetId: args.targetId,
    isDestinationRegistered: isRegistered,
    signal: args.signal
  })
}

/** Clear active only after proven slot exit; daemon terminals may outlive it. */
async function stopStrandedHivewardd(targetId: string, signal?: AbortSignal): Promise<void> {
  const target = getSshTargetRegistryStore()?.getTarget(targetId)
  const connectionManager = getSshConnectionManager()
  if (!target || !connectionManager) {
    return
  }
  const context = await resolveHivewarddRemoteContext(
    target,
    sshHivewarddHostTransport(await connectionManager.connect(target)),
    signal
  )
  if (!context.activationRecord.active) {
    return
  }
  // Port is irrelevant because this recovery never launches a slot.
  const slot = managedHivewarddSlot(context, 0, signal)
  await withHivewarddActivationLock(
    slot,
    async () => {
      const record = await readHivewarddActivationRecord(slot)
      if (!record.active) {
        return
      }
      const stopped = await stopHivewarddSlot(slot, hivewarddSlotDir(slot, record.active), false)
      if (hivewarddStopFreedTheHost(stopped)) {
        await writeHivewarddActivationRecord(slot, withDeactivatedVersionCommitted(record))
      }
    },
    () => undefined
  )
}
