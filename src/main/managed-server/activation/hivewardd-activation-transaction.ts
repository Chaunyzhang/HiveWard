// Journal before mutation and retain until the recorded slot is restored; recordAfter/core matching determines commit during recovery.
import {
  parseHivewarddActivationRecord,
  coreHivewarddActivationRecord,
  serializeHivewarddActivationRecord,
  type HivewarddActivationRecord
} from './hivewardd-activation-record'
import {
  type HIVEWARDD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
  HivewarddActivationTransactionSchema
} from './hivewardd-activation-transaction-schema'
import {
  hivewarddDecommissionJournal,
  hivewarddDecommissionTransactionDefect,
  planHivewarddDecommissionRecovery,
  type HivewarddDecommissionRecoveryPlan,
  type HivewarddDecommissionTransaction
} from '../lifecycle/hivewardd-decommission-transaction'
import { errorMessage } from '../../../shared/error-message'
import { RELAY_INSTALL_LOCK_NAME } from '../../../shared/relay-install-lock-name'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

export const HIVEWARDD_ACTIVATION_TRANSACTION_FILENAME = 'transaction.json'
export const HIVEWARDD_ACTIVATION_TRANSACTION_DIRNAME = '.hivewardd-activation-transaction'

export function hivewarddActivationTransactionRoot(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, HIVEWARDD_ACTIVATION_TRANSACTION_DIRNAME)
}

export function hivewarddActivationFenceLockDir(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(
    host,
    hivewarddActivationTransactionRoot(host, remoteHome),
    RELAY_INSTALL_LOCK_NAME
  )
}

export function hivewarddActivationTransactionPath(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  return joinRemotePath(
    host,
    hivewarddActivationTransactionRoot(host, remoteHome),
    HIVEWARDD_ACTIVATION_TRANSACTION_FILENAME
  )
}

export type HivewarddSnapshotVerdict = {
  dirName: string
  state: 'pending' | 'captured' | 'empty'
}

export type HivewarddActivateTransaction = {
  schemaVersion: typeof HIVEWARDD_ACTIVATION_TRANSACTION_SCHEMA_VERSION
  transactionId: string
  operation: 'activate'
  phase: 'prepared' | 'incumbent-stopped' | 'snapshot-captured' | 'candidate-ready'
  startedAt: string
  updatedAt: string
  candidateVersion: string
  /** Retain the initiating app version when recovery finishes the activation commit. */
  candidateAppVersion?: string | null
  recordBefore: HivewarddActivationRecord
  recordAfter: HivewarddActivationRecord | null
  snapshot: HivewarddSnapshotVerdict
}

export type HivewarddRollbackTransaction = {
  schemaVersion: typeof HIVEWARDD_ACTIVATION_TRANSACTION_SCHEMA_VERSION
  transactionId: string
  operation: 'rollback'
  phase:
    | 'prepared'
    | 'incumbent-stopped'
    | 'rescue-captured'
    | 'rollback-state-restored'
    | 'target-ready'
  startedAt: string
  updatedAt: string
  incumbentVersion: string
  targetVersion: string
  recordBefore: HivewarddActivationRecord
  recordAfter: HivewarddActivationRecord
  rescue: HivewarddSnapshotVerdict
}

export type HivewarddActivationTransaction =
  | HivewarddActivateTransaction
  | HivewarddRollbackTransaction
  | HivewarddDecommissionTransaction

type HivewarddActivationTransactionReadResult =
  | { state: 'absent' }
  | { state: 'ok'; transaction: HivewarddActivationTransaction }
  | { state: 'unreadable'; reason: string }

/** Recovery must quiesce the launched slot before undoing state. */
type HivewarddTransactionRecoveryPlan =
  | { action: 'stabilize-committed'; activeVersion: string | null }
  /** Candidate passed readiness; only committing its journaled activation record remains. */
  | { action: 'finish-commit'; record: HivewarddActivationRecord }
  | {
      action: 'undo'
      /** Slot that may have used state after the handoff. */
      launchedVersion: string | null
      activeVersion: string | null
      restoreState: HivewarddSnapshotVerdict | null
      launchedFromState?: HivewarddSnapshotVerdict | null
    }
  | HivewarddDecommissionRecoveryPlan
  | { action: 'refuse'; code: string; reason: string }

export function parseHivewarddActivationTransaction(
  raw: string | null
): HivewarddActivationTransactionReadResult {
  if (raw === null || raw.trim() === '') {
    return { state: 'absent' }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return unreadable(`transaction is not JSON: ${errorMessage(error)}`)
  }
  const parsed = HivewarddActivationTransactionSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.length ? issue.path.join('.') : 'transaction'
    return unreadable(`${path} is invalid: ${issue?.message ?? 'unknown shape'}`)
  }
  const recordBefore = parseNestedRecord(parsed.data.recordBefore, 'recordBefore')
  if (recordBefore.state === 'unreadable') {
    return recordBefore
  }
  if (parsed.data.operation === 'decommission') {
    const after = parseNestedRecord(parsed.data.recordAfter, 'recordAfter')
    if (after.state === 'unreadable') {
      return after
    }
    const { dispatched, ...journal } = parsed.data
    const transaction = {
      ...journal,
      ...dispatched,
      recordBefore: recordBefore.record,
      recordAfter: after.record
    }
    const defect = hivewarddDecommissionTransactionDefect(transaction)
    return defect ? unreadable(defect) : { state: 'ok', transaction }
  }
  if (parsed.data.operation === 'activate') {
    const recordAfter =
      parsed.data.recordAfter === null
        ? null
        : parseNestedRecord(parsed.data.recordAfter, 'recordAfter')
    if (recordAfter?.state === 'unreadable') {
      return recordAfter
    }
    if (recordAfter && recordAfter.record.active !== parsed.data.candidateVersion) {
      return unreadable('recordAfter does not activate candidateVersion')
    }
    return {
      state: 'ok',
      transaction: {
        ...parsed.data,
        recordBefore: recordBefore.record,
        recordAfter: recordAfter?.record ?? null
      }
    }
  }
  const recordAfter = parseNestedRecord(parsed.data.recordAfter, 'recordAfter')
  if (recordAfter.state === 'unreadable') {
    return recordAfter
  }
  if (
    recordBefore.record.active !== parsed.data.incumbentVersion ||
    recordBefore.record.previous !== parsed.data.targetVersion
  ) {
    return unreadable('rollback versions do not match recordBefore')
  }
  if (
    recordAfter.record.active !== parsed.data.targetVersion ||
    recordAfter.record.previous !== null ||
    recordAfter.record.snapshot !== null
  ) {
    return unreadable('recordAfter is not a completed rollback record')
  }
  return {
    state: 'ok',
    transaction: {
      ...parsed.data,
      recordBefore: recordBefore.record,
      recordAfter: recordAfter.record
    }
  }
}

export function serializeHivewarddActivationTransaction(
  transaction: HivewarddActivationTransaction & { fenceToken?: string }
): string {
  // Decommission serialization must preserve any existing fenceToken.
  const journal =
    transaction.operation === 'decommission' ? hivewarddDecommissionJournal(transaction) : transaction
  return `${JSON.stringify(journal, null, 2)}\n`
}

export function planHivewarddTransactionRecovery(
  transaction: HivewarddActivationTransaction,
  currentRecord: HivewarddActivationRecord
): HivewarddTransactionRecoveryPlan {
  if (transaction.operation === 'decommission') {
    const committed = sameHivewarddActivationRecord(currentRecord, transaction.recordAfter)
    return committed || sameHivewarddActivationRecord(currentRecord, transaction.recordBefore)
      ? planHivewarddDecommissionRecovery(transaction, committed)
      : recordChangedRefusal(transaction)
  }
  if (
    transaction.recordAfter &&
    sameHivewarddActivationRecord(currentRecord, transaction.recordAfter)
  ) {
    return {
      action: 'stabilize-committed',
      activeVersion: transaction.recordAfter.active
    }
  }
  if (!sameHivewarddActivationRecord(currentRecord, transaction.recordBefore)) {
    return recordChangedRefusal(transaction)
  }
  if (transaction.phase === 'candidate-ready' || transaction.phase === 'target-ready') {
    return {
      action: 'finish-commit',
      record: transaction.recordAfter ?? neverRecord()
    }
  }
  if (transaction.operation === 'activate') {
    // Launch follows a durable snapshot verdict.
    const launched = transaction.phase === 'snapshot-captured'
    return {
      action: 'undo',
      launchedVersion: launched ? transaction.candidateVersion : null,
      activeVersion: transaction.recordBefore.active,
      restoreState: launched ? transaction.snapshot : null
    }
  }
  // Rescue holds incumbent state; restore it once target-state replacement may have begun.
  const replaced = transaction.phase === 'rollback-state-restored'
  const rescued = replaced || transaction.phase === 'rescue-captured'
  return {
    action: 'undo',
    launchedVersion: replaced ? transaction.targetVersion : null,
    activeVersion: transaction.incumbentVersion,
    // A mid-restore crash retains rescue-captured even when live state is already partly replaced.
    restoreState: rescued ? transaction.rescue : null,
    launchedFromState: replaced ? rollbackStartingState(transaction) : null
  }
}

export function rollbackStartingState(
  transaction: Pick<HivewarddRollbackTransaction, 'recordBefore'>
): HivewarddSnapshotVerdict | null {
  const snapshot = transaction.recordBefore.snapshot
  return snapshot ? { dirName: snapshot.dirName, state: 'captured' } : null
}

export function sameHivewarddActivationRecord(
  left: HivewarddActivationRecord,
  right: HivewarddActivationRecord
): boolean {
  return (
    serializeHivewarddActivationRecord(coreHivewarddActivationRecord(left)) ===
    serializeHivewarddActivationRecord(coreHivewarddActivationRecord(right))
  )
}

function parseNestedRecord(
  value: unknown,
  field: string
): { state: 'ok'; record: HivewarddActivationRecord } | { state: 'unreadable'; reason: string } {
  const parsed = parseHivewarddActivationRecord(JSON.stringify(value))
  return parsed.state === 'ok'
    ? { state: 'ok', record: parsed.record }
    : unreadable(
        `${field} is invalid: ${parsed.state === 'absent' ? 'record is absent' : parsed.reason}`
      )
}

function recordChangedRefusal(
  transaction: HivewarddActivationTransaction
): Extract<HivewarddTransactionRecoveryPlan, { action: 'refuse' }> {
  return {
    action: 'refuse',
    code: 'hivewardd_recovery_activation_record_changed',
    reason:
      `The activation record matches neither side of the interrupted ${transaction.operation}. ` +
      'Preserving the activation fence for operator inspection.'
  }
}

function neverRecord(): never {
  throw new Error('A committed phase must carry its record; the schema enforces this.')
}

function unreadable(reason: string): { state: 'unreadable'; reason: string } {
  return { state: 'unreadable', reason }
}
