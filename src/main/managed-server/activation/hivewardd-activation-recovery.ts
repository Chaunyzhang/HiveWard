// Reconcile interrupted transactions to the recorded slot and state; retain the fence whenever ownership remains unproven.
import type { ServeReadiness } from '../../server/serve-readiness'
import {
  planHivewarddTransactionRecovery,
  type HivewarddActivationTransaction
} from './hivewardd-activation-transaction'
import { readHivewarddActivationTransaction } from './hivewardd-activation-transaction-store'
import {
  readHivewarddActivationRecord,
  writeHivewarddActivationRecord
} from './hivewardd-activation-record-store'
import {
  hivewarddActivationFenceExists,
  withStaleHivewarddActivationRecoveryLock
} from './hivewardd-activation-lock'
import { RemoteInstallLockBusyError } from '../install/remote-install-lock'
import { ensureHivewarddSlotServing, resolveHivewarddSlotIdentity } from '../../ssh/hivewardd-recovery-slot'
import { reconcileHivewarddDecommission } from '../lifecycle/hivewardd-decommission-recovery'
import {
  recoverHivewarddIncumbent,
  type HivewarddIncumbentRecoveryOptions
} from '../../ssh/hivewardd-incumbent-recovery'
import type { HivewarddManagedRefusal } from '../../../shared/hivewardd-managed-runtime'
import { resumeInterruptedHivewarddCandidate } from '../../ssh/hivewardd-interrupted-candidate-resume'
import { errorMessage } from '../../../shared/error-message'

export type HivewarddActivationRecoveryResult =
  | { outcome: 'none' }
  | { outcome: 'pending'; code: string; reason: string }
  | {
      outcome: 'recovered'
      resolution: 'committed' | 'restored-incumbent'
      activeVersion: string | null
      readiness: ServeReadiness | null
    }
  | HivewarddManagedRefusal

type HivewarddActivationRecoveryOptions = HivewarddIncumbentRecoveryOptions

export const HIVEWARDD_RECOVERY_UNVERIFIABLE_CODE = 'hivewardd_recovery_unverifiable'

/** Both pre-fence answers, read moments ago on this connect; they only skip the same two reads. */
export type HivewarddActivationIdlePreRead = { transactionAbsent: boolean; fenceOpen: boolean }

export async function recoverInterruptedHivewarddActivation(
  options: HivewarddActivationRecoveryOptions,
  preRead?: HivewarddActivationIdlePreRead
): Promise<HivewarddActivationRecoveryResult> {
  if (preRead?.transactionAbsent && preRead.fenceOpen) {
    return { outcome: 'none' }
  }
  try {
    if (
      !(await readHivewarddActivationTransaction(options)) &&
      !(await hivewarddActivationFenceExists(options))
    ) {
      return { outcome: 'none' }
    }
    return await withStaleHivewarddActivationRecoveryLock(options, async (lock) => {
      const transaction = await readHivewarddActivationTransaction(options)
      if (!transaction) {
        // Interrupted release can remove the journal before the fence; finishing release is enough.
        return { outcome: 'none' }
      }
      const result = await reconcileHivewarddTransaction(options, transaction)
      if (result.outcome !== 'recovered') {
        lock.retain()
      }
      return result
    })
  } catch (error) {
    if (error instanceof RemoteInstallLockBusyError) {
      return {
        outcome: 'pending',
        code: 'hivewardd_recovery_transaction_still_fresh',
        reason:
          'The activation fence is held by a run that may still be working. Retry after the ' +
          'install lock recovery window.'
      }
    }
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: HIVEWARDD_RECOVERY_UNVERIFIABLE_CODE,
      reason:
        `The interrupted activation could not be reconciled safely: ${errorMessage(error)} ` +
        'The host remains fenced.'
    }
  }
}

/** Requires a held fence; unverifiable steps throw to preserve it. */
async function reconcileHivewarddTransaction(
  options: HivewarddActivationRecoveryOptions,
  transaction: HivewarddActivationTransaction
): Promise<HivewarddActivationRecoveryResult> {
  const plan = planHivewarddTransactionRecovery(transaction, await readHivewarddActivationRecord(options))
  if (plan.action === 'refuse') {
    return { outcome: 'refused', verdict: 'unverifiable', code: plan.code, reason: plan.reason }
  }
  if (
    plan.action === 'confirm-decommissioned' ||
    plan.action === 'resume-stop' ||
    plan.action === 'keep-serving'
  ) {
    return reconcileHivewarddDecommission(options, plan)
  }
  if (plan.action === 'finish-commit') {
    await writeHivewarddActivationRecord(options, plan.record)
  }
  if (plan.action === 'stabilize-committed' || plan.action === 'finish-commit') {
    const activeVersion = plan.action === 'finish-commit' ? plan.record.active : plan.activeVersion
    if (!activeVersion) {
      throw new Error('The committed activation record has no active version.')
    }
    const identity = await resolveHivewarddSlotIdentity(options, activeVersion)
    return {
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion,
      readiness: await ensureHivewarddSlotServing(options, identity)
    }
  }
  if (transaction.operation === 'activate' && plan.launchedVersion) {
    const readiness = await resumeInterruptedHivewarddCandidate(options, transaction)
    if (readiness && 'outcome' in readiness) {
      return readiness
    }
    if (readiness) {
      return {
        outcome: 'recovered',
        resolution: 'committed',
        activeVersion: transaction.candidateVersion,
        readiness
      }
    }
  }
  const recovery = await recoverHivewarddIncumbent(options, {
    transactionStartedAt: transaction.startedAt,
    launchedVersion: plan.launchedVersion,
    incumbent: plan.activeVersion
      ? await resolveHivewarddSlotIdentity(options, plan.activeVersion)
      : null,
    restoreState: plan.restoreState,
    launchedFromState: plan.launchedFromState
  })
  return recovery.outcome === 'refused'
    ? recovery
    : {
        outcome: 'recovered',
        resolution: 'restored-incumbent',
        activeVersion: plan.activeVersion,
        readiness: recovery.readiness
      }
}
