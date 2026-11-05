import {
  hivewarddActivationTransactionPath,
  parseHivewarddActivationTransaction,
  serializeHivewarddActivationTransaction,
  type HivewarddActivationTransaction
} from './hivewardd-activation-transaction'
import {
  readBoundedHivewarddRemoteRecord,
  writeAtomicHivewarddRemoteRecord
} from '../install/hivewardd-remote-record-file'
import type { HivewarddRemoteExecTarget } from '../install/hivewardd-remote-runtime-control'
import { currentHivewarddFence } from './hivewardd-activation-fence-scope'

const HIVEWARDD_ACTIVATION_TRANSACTION_MAX_BYTES = 64 * 1024

type HivewarddActivationTransactionStoreOptions = HivewarddRemoteExecTarget & { remoteHome: string }

/** Only verified absence returns null; unreadable journals retain the fence. */
export async function readHivewarddActivationTransaction(
  options: HivewarddActivationTransactionStoreOptions
): Promise<HivewarddActivationTransaction | null> {
  const read = await readBoundedHivewarddRemoteRecord(
    options,
    hivewarddActivationTransactionPath(options.host, options.remoteHome),
    HIVEWARDD_ACTIVATION_TRANSACTION_MAX_BYTES
  )
  const parsed = parseHivewarddActivationTransaction(read.state === 'present' ? read.raw : null)
  if (parsed.state === 'unreadable') {
    throw new Error(`Cannot read this host's hivewardd activation transaction: ${parsed.reason}`)
  }
  return parsed.state === 'ok' ? parsed.transaction : null
}

/** Stamp each write with its fence generation so release cannot delete another holder's journal. */
export function writeHivewarddActivationTransaction(
  options: HivewarddActivationTransactionStoreOptions,
  transaction: HivewarddActivationTransaction
): Promise<void> {
  const fenceToken = currentHivewarddFence()?.token
  return writeAtomicHivewarddRemoteRecord(
    options,
    hivewarddActivationTransactionPath(options.host, options.remoteHome),
    serializeHivewarddActivationTransaction(fenceToken ? { ...transaction, fenceToken } : transaction)
  )
}
