/** Resume through the original readiness gate before undoing: the candidate may already serve changed state, and stopping it could require operator consent before anything can serve again. */
import type { ServeReadiness } from '../server/serve-readiness'
import { withActivatedVersion } from '../managed-server/activation/hivewardd-activation-record'
import { writeHivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record-store'
import type { HivewarddActivateTransaction } from '../managed-server/activation/hivewardd-activation-transaction'
import { writeHivewarddActivationTransaction } from '../managed-server/activation/hivewardd-activation-transaction-store'
import { withHivewarddActivationCandidateReady } from '../managed-server/activation/hivewardd-activation-transaction-transitions'
import { HivewarddActiveReadinessError } from './hivewardd-active-readiness'
import { hivewarddLivenessProvenExited } from '../managed-server/install/hivewardd-remote-launch'
import {
  HIVEWARDD_RECOVERY_CHANGED_STATE_CODE,
  type HivewarddManagedRefusal
} from '../../shared/hivewardd-managed-runtime'
import {
  ensureHivewarddSlotServing,
  hivewarddSlotDir,
  resolveHivewarddSlotIdentity,
  slotLiveness
} from './hivewardd-recovery-slot'
import type { HivewarddIncumbentRecoveryOptions } from './hivewardd-incumbent-recovery'

/** Under the held fence, return null for undo; a refusal leaves the host untouched for an operator. */
export async function resumeInterruptedHivewarddCandidate(
  options: HivewarddIncumbentRecoveryOptions,
  transaction: HivewarddActivateTransaction
): Promise<ServeReadiness | HivewarddManagedRefusal | null> {
  const snapshotState = transaction.snapshot.state
  const incumbent = transaction.recordBefore.active
  if (
    transaction.phase !== 'snapshot-captured' ||
    snapshotState === 'pending' ||
    // A serving incumbent holds the port and instance lock; undo keeps it.
    (incumbent !== null &&
      !hivewarddLivenessProvenExited(await slotLiveness(options, hivewarddSlotDir(options, incumbent))))
  ) {
    return null
  }
  const candidate = await resolveHivewarddSlotIdentity(options, transaction.candidateVersion)
  const candidateLiveness = await slotLiveness(options, candidate.remoteDir)
  // Old journals lack candidate app version, so commit would drop downgrade protection; undo a possibly serving candidate only with consent.
  if (transaction.candidateAppVersion === undefined) {
    if (hivewarddLivenessProvenExited(candidateLiveness) || options.acceptChangedState) {
      return null
    }
    if (candidateLiveness === 'UNKNOWN') {
      throw new Error(`Could not tell whether hivewardd ${transaction.candidateVersion} is running.`)
    }
    return {
      outcome: 'refused',
      verdict: 'live',
      code: HIVEWARDD_RECOVERY_CHANGED_STATE_CODE,
      reason:
        `An older HiveWard left version ${transaction.candidateVersion} running without finishing ` +
        'its update, and did not record which app started it, so it was neither committed nor ' +
        'stopped. Recover to stop it, restore the prelaunch snapshot and restart the previous ' +
        'build; what it changed is discarded.'
    }
  }
  // Undo must rule out an unprovable candidate before starting another slot.
  if (candidateLiveness === 'UNKNOWN') {
    return null
  }
  let readiness: ServeReadiness
  try {
    readiness = await ensureHivewarddSlotServing(options, candidate)
  } catch (error) {
    // Only candidate evidence permits undo; unanswered hosts retain the fence.
    if (error instanceof HivewarddActiveReadinessError && error.verdict !== 'unverifiable') {
      return null
    }
    throw error
  }
  const now = new Date()
  const recordAfter = withActivatedVersion(
    transaction.recordBefore,
    transaction.candidateVersion,
    snapshotState === 'captured'
      ? {
          dirName: transaction.snapshot.dirName,
          takenBeforeVersion: transaction.candidateVersion,
          readableByVersion: incumbent,
          takenAt: transaction.startedAt
        }
      : null,
    now,
    transaction.candidateAppVersion ?? undefined
  )
  await writeHivewarddActivationTransaction(
    options,
    withHivewarddActivationCandidateReady(transaction, recordAfter, now)
  )
  await writeHivewarddActivationRecord(options, recordAfter)
  return readiness
}
