import type { HivewarddActivationRecord } from './hivewardd-activation-record'
import { HIVEWARDD_ACTIVATION_TRANSACTION_SCHEMA_VERSION } from './hivewardd-activation-transaction-schema'
import type {
  HivewarddActivateTransaction,
  HivewarddRollbackTransaction
} from './hivewardd-activation-transaction'

export function createHivewarddActivationTransaction(options: {
  transactionId: string
  candidateVersion: string
  appVersion?: string
  recordBefore: HivewarddActivationRecord
  snapshotDirName: string
  now: Date
}): HivewarddActivateTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: HIVEWARDD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'activate',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    candidateVersion: options.candidateVersion,
    candidateAppVersion: options.appVersion ?? null,
    recordBefore: options.recordBefore,
    recordAfter: null,
    snapshot: { dirName: options.snapshotDirName, state: 'pending' }
  }
}

export function withHivewarddActivationIncumbentStopped(
  transaction: HivewarddActivateTransaction,
  now: Date
): HivewarddActivateTransaction {
  return {
    ...transaction,
    phase: 'incumbent-stopped',
    updatedAt: now.toISOString()
  }
}

export function withHivewarddActivationSnapshot(
  transaction: HivewarddActivateTransaction,
  state: 'captured' | 'empty',
  now: Date
): HivewarddActivateTransaction {
  return {
    ...transaction,
    phase: 'snapshot-captured',
    updatedAt: now.toISOString(),
    snapshot: { dirName: transaction.snapshot.dirName, state }
  }
}

export function withHivewarddActivationCandidateReady(
  transaction: HivewarddActivateTransaction,
  recordAfter: HivewarddActivationRecord,
  now: Date
): HivewarddActivateTransaction {
  return {
    ...transaction,
    phase: 'candidate-ready',
    updatedAt: now.toISOString(),
    recordAfter
  }
}

export function createHivewarddRollbackTransaction(options: {
  transactionId: string
  incumbentVersion: string
  targetVersion: string
  recordBefore: HivewarddActivationRecord
  recordAfter: HivewarddActivationRecord
  rescueDirName: string
  now: Date
}): HivewarddRollbackTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: HIVEWARDD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'rollback',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    incumbentVersion: options.incumbentVersion,
    targetVersion: options.targetVersion,
    recordBefore: options.recordBefore,
    recordAfter: options.recordAfter,
    rescue: { dirName: options.rescueDirName, state: 'pending' }
  }
}

export function withHivewarddRollbackPhase(
  transaction: HivewarddRollbackTransaction,
  phase: 'incumbent-stopped' | 'rollback-state-restored' | 'target-ready',
  now: Date
): HivewarddRollbackTransaction {
  return { ...transaction, phase, updatedAt: now.toISOString() }
}

export function withHivewarddRollbackRescue(
  transaction: HivewarddRollbackTransaction,
  state: 'captured' | 'empty',
  now: Date
): HivewarddRollbackTransaction {
  return {
    ...transaction,
    phase: 'rescue-captured',
    updatedAt: now.toISOString(),
    rescue: { dirName: transaction.rescue.dirName, state }
  }
}
