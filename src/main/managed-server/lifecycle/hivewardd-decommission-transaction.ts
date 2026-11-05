// Only process-exited may commit; dispatched phases nest under prepared for released readers.
import {
  serializeHivewarddActivationRecord,
  withDeactivatedVersion,
  withDeactivatedVersionCommitted,
  type HivewarddActivationRecord
} from '../activation/hivewardd-activation-record'
import { HIVEWARDD_ACTIVATION_TRANSACTION_SCHEMA_VERSION } from '../activation/hivewardd-activation-transaction-schema'
import type { HivewarddManagedStopRequest } from '../../../shared/hivewardd-stop-request'

export type HivewarddDecommissionTransaction = {
  schemaVersion: typeof HIVEWARDD_ACTIVATION_TRANSACTION_SCHEMA_VERSION
  transactionId: string
  operation: 'decommission'
  phase: 'prepared' | 'stop-dispatched' | 'process-exited'
  startedAt: string
  updatedAt: string
  activeVersion: string
  recordBefore: HivewarddActivationRecord
  recordAfter: HivewarddActivationRecord
  request: HivewarddManagedStopRequest | null
}

/** Released desktops drop this field. */
type HivewarddDecommissionDispatch = {
  phase: 'stop-dispatched' | 'process-exited'
  request: HivewarddManagedStopRequest
}

type HivewarddDecommissionJournal = Omit<HivewarddDecommissionTransaction, 'phase' | 'request'> & {
  phase: 'prepared'
  request: null
  dispatched?: HivewarddDecommissionDispatch
}

export type HivewarddDecommissionRecoveryPlan =
  | { action: 'confirm-decommissioned'; version: string; record: HivewarddActivationRecord | null }
  /** Completion or cancellation must settle a possibly delivered request. */
  | { action: 'resume-stop'; request: HivewarddManagedStopRequest; record: HivewarddActivationRecord }
  | { action: 'keep-serving'; version: string }

export function createHivewarddDecommissionTransaction(options: {
  transactionId: string
  recordBefore: HivewarddActivationRecord & { active: string }
  now: Date
}): HivewarddDecommissionTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: HIVEWARDD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'decommission',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    activeVersion: options.recordBefore.active,
    recordBefore: options.recordBefore,
    recordAfter: withDeactivatedVersion(options.recordBefore),
    request: null
  }
}

export function withHivewarddDecommissionStopDispatched(
  transaction: HivewarddDecommissionTransaction,
  request: HivewarddManagedStopRequest,
  now: Date
): HivewarddDecommissionTransaction {
  return { ...transaction, phase: 'stop-dispatched', updatedAt: now.toISOString(), request }
}

export function withHivewarddDecommissionProcessExited(
  transaction: HivewarddDecommissionTransaction,
  now: Date
): HivewarddDecommissionTransaction {
  return { ...transaction, phase: 'process-exited', updatedAt: now.toISOString() }
}

/** Keep top-level prepared so released readers relaunch the recorded build instead of downgrading.
 * Their parser drops dispatched; their completed-stop path loses activeAppVersion protection. */
export function hivewarddDecommissionJournal(
  transaction: HivewarddDecommissionTransaction
): HivewarddDecommissionJournal {
  const { phase, request, ...rest } = transaction
  return phase === 'prepared' || !request
    ? { ...rest, phase: 'prepared', request: null }
    : { ...rest, phase: 'prepared', request: null, dispatched: { phase, request } }
}

export function hivewarddDecommissionTransactionDefect(
  transaction: HivewarddDecommissionTransaction
): string | null {
  if (transaction.recordBefore.active !== transaction.activeVersion) {
    return 'decommission version does not match recordBefore'
  }
  if (
    serializeHivewarddActivationRecord(transaction.recordAfter) !==
    serializeHivewarddActivationRecord(withDeactivatedVersion(transaction.recordBefore))
  ) {
    return 'recordAfter is not the deactivated recordBefore'
  }
  if (transaction.request && transaction.request.version !== transaction.activeVersion) {
    return 'stop request names another version'
  }
  return null
}

export function planHivewarddDecommissionRecovery(
  transaction: HivewarddDecommissionTransaction,
  committed: boolean
): HivewarddDecommissionRecoveryPlan {
  if (committed) {
    return { action: 'confirm-decommissioned', version: transaction.activeVersion, record: null }
  }
  if (transaction.phase === 'process-exited') {
    return {
      action: 'confirm-decommissioned',
      version: transaction.activeVersion,
      record: committedHivewarddDecommissionRecord(transaction)
    }
  }
  if (transaction.phase === 'stop-dispatched' && transaction.request) {
    return {
      action: 'resume-stop',
      request: transaction.request,
      record: committedHivewarddDecommissionRecord(transaction)
    }
  }
  return { action: 'keep-serving', version: transaction.activeVersion }
}

/** Preserve advisory fields alongside the journaled recordAfter. */
export function committedHivewarddDecommissionRecord(
  transaction: HivewarddDecommissionTransaction
): HivewarddActivationRecord {
  return withDeactivatedVersionCommitted(transaction.recordBefore)
}
