/** Pin every journaled slot needed for recovery. An unreadable journal or unjournaled held fence hides transaction state, so GC must retain everything. */
import { hivewarddInstallDirNames } from '../managed-server/activation/hivewardd-activation-record'
import type { HivewarddActivationTransaction } from '../managed-server/activation/hivewardd-activation-transaction'
import { readHivewarddActivationTransaction } from '../managed-server/activation/hivewardd-activation-transaction-store'
import { hivewarddActivationFenceExists } from '../managed-server/activation/hivewardd-activation-lock'
import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'
import type { HivewarddRemoteExecTarget } from '../managed-server/install/hivewardd-remote-runtime-control'

type HivewarddGcTransactionPins = { state: 'pinned'; dirNames: string[] } | { state: 'keep-all' }

function transactionVersions(transaction: HivewarddActivationTransaction): (string | null)[] {
  const records = [transaction.recordBefore, transaction.recordAfter]
  const fromRecords = records.flatMap((record) => (record ? [record.active, record.previous] : []))
  if (transaction.operation === 'activate') {
    return [...fromRecords, transaction.candidateVersion]
  }
  return transaction.operation === 'rollback'
    ? [...fromRecords, transaction.incumbentVersion, transaction.targetVersion]
    : fromRecords
}

export async function readHivewarddGcTransactionPins(
  target: HivewarddRemoteExecTarget & { remoteHome: string }
): Promise<HivewarddGcTransactionPins> {
  try {
    const transaction = await readHivewarddActivationTransaction(target)
    if (!transaction) {
      // An unjournaled fence may be a transaction starting or an interrupted release.
      return (await hivewarddActivationFenceExists(target))
        ? { state: 'keep-all' }
        : { state: 'pinned', dirNames: [] }
    }
    return { state: 'pinned', dirNames: hivewarddInstallDirNames(transactionVersions(transaction)) }
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return { state: 'keep-all' }
  }
}
