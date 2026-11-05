import type { HivewarddActivationLockControl } from '../managed-server/activation/hivewardd-activation-lock'
import type { HivewarddSnapshotVerdict } from '../managed-server/activation/hivewardd-activation-transaction'
import { hivewarddStopFreedTheHost } from '../managed-server/install/hivewardd-remote-process-control'
import { withoutAbortSignal } from '../managed-server/install/hivewardd-remote-runtime-control'
import {
  launchHivewarddSlot,
  stopHivewarddSlot,
  HIVEWARDD_SLOT_STOP_WAIT_SECONDS,
  type HivewarddSlotIdentity,
  type HivewarddSlotOptions
} from './hivewardd-recovery-slot'
import { recoverHivewarddIncumbent } from './hivewardd-incumbent-recovery'
import { errorMessage } from '../../shared/error-message'

/** Return null on proven exit; otherwise retain the fence when a delivered stop may still change the host. */
export async function stopTransactionIncumbent(
  options: HivewarddSlotOptions,
  incumbent: HivewarddSlotIdentity,
  lock: HivewarddActivationLockControl
): Promise<{ reason: string; stopMayBeUnderway: boolean } | null> {
  const stopped = await stopHivewarddSlot(options, incumbent.remoteDir, false)
  if (hivewarddStopFreedTheHost(stopped)) {
    return null
  }
  // Only a stop that may have been delivered can still change the host; otherwise nothing happened.
  const stopMayBeUnderway = stopped === 'still-running' || stopped === 'unconfirmed'
  if (stopMayBeUnderway) {
    lock.retain()
  }
  return {
    reason:
      `Could not verify that hivewardd ${incumbent.version} exited within ` +
      `${HIVEWARDD_SLOT_STOP_WAIT_SECONDS}s (${stopped}).`,
    stopMayBeUnderway
  }
}

export async function restartAfterSnapshotFailure(
  options: HivewarddSlotOptions,
  incumbent: HivewarddSlotIdentity,
  lock: HivewarddActivationLockControl
): Promise<string> {
  try {
    await launchHivewarddSlot(withoutAbortSignal(options), incumbent)
    lock.recovered()
    return `hivewardd ${incumbent.version} was restarted and is serving again.`
  } catch (error) {
    lock.retain()
    return `restarting hivewardd ${incumbent.version} failed: ${errorMessage(error)} This host requires recovery.`
  }
}

/** Restore changed state and incumbent only after both slots prove exit; refusal retains the fence. */
export async function putTransactionIncumbentBack(
  options: HivewarddSlotOptions,
  lock: HivewarddActivationLockControl,
  input: {
    transactionStartedAt: string
    launchedVersion: string | null
    incumbent: HivewarddSlotIdentity | null
    restoreState: HivewarddSnapshotVerdict | null
    launchedFromState?: HivewarddSnapshotVerdict | null
  }
): Promise<string | null> {
  try {
    const recovery = await recoverHivewarddIncumbent(withoutAbortSignal(options), {
      ...input,
      slotsProvenExited: true
    })
    if (recovery.outcome === 'refused') {
      lock.retain()
      return recovery.reason
    }
    lock.recovered()
    return null
  } catch (error) {
    lock.retain()
    return `Restoring the previous version failed: ${errorMessage(error)} This host requires recovery.`
  }
}

/** Stop the rejected candidate before safely restoring incumbent state. */
export async function restoreAfterRejectedCandidate(
  options: HivewarddSlotOptions,
  lock: HivewarddActivationLockControl,
  input: {
    launchedDir: string
    launchedVersion: string
    transactionStartedAt: string
    incumbent: HivewarddSlotIdentity | null
    restoreState: HivewarddSnapshotVerdict | null
    launchedFromState?: HivewarddSnapshotVerdict | null
  }
): Promise<string> {
  const { launchedDir, ...restore } = input
  const stopped = await stopHivewarddSlot(withoutAbortSignal(options), launchedDir, true).catch(
    (error: unknown) => `unverifiable: ${errorMessage(error)}`
  )
  if (stopped !== 'stopped' && stopped !== 'already-exited') {
    lock.retain()
    return (
      `hivewardd ${input.launchedVersion} could not be confirmed stopped (${stopped}), so nothing ` +
      'was restored over state it may still own. This host requires recovery.'
    )
  }
  const failure = await putTransactionIncumbentBack(options, lock, restore)
  return (
    failure ??
    (input.incumbent
      ? `hivewardd ${input.incumbent.version} was restarted and is serving again.`
      : 'No previous version was active, so this host is now serving nothing.')
  )
}
