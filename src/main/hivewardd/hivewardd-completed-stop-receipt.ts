import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { hasErrorCode } from '../daemon/daemon-process-inspection'
import {
  HIVEWARDD_STOP_RECEIPTS_DIRNAME,
  HivewarddCompletedStopReceiptSchema,
  HivewarddManagedStopRequestSchema,
  HivewarddDaemonRetirementRecordSchema,
  hivewarddManagedStopRequestKey,
  type HivewarddCompletedStopReceipt,
  type HivewarddDaemonRetirementRecord,
  type HivewarddManagedStopRequest
} from '../../shared/hivewardd-stop-request'

const RECEIPT_MAX_BYTES = 64 * 1024

type ReceiptKind = 'completed' | 'retirement' | 'decision'

export function hivewarddStopReceiptPath(request: HivewarddManagedStopRequest, kind: ReceiptKind): string {
  const { transactionId, instance } = HivewarddManagedStopRequestSchema.parse(request)
  const suffix = kind === 'completed' ? '' : `.${kind}`
  return join(
    dirname(instance.lockPath),
    HIVEWARDD_STOP_RECEIPTS_DIRNAME,
    `${transactionId}${suffix}.json`
  )
}

/** Absent returns null; mismatched request receipts throw. */
export function readHivewarddStopReceipt<T extends { request: HivewarddManagedStopRequest }>(
  request: HivewarddManagedStopRequest,
  kind: ReceiptKind,
  schema: z.ZodType<T>
): T | null {
  const path = hivewarddStopReceiptPath(request, kind)
  try {
    if (!lstatSync(path).isFile()) {
      throw new Error('hivewardd_stop_receipt_unverifiable')
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
  const receipt = schema.parse(
    JSON.parse(readNodeFileSyncWithinLimit(path, RECEIPT_MAX_BYTES).buffer.toString('utf8'))
  )
  if (hivewarddManagedStopRequestKey(receipt.request) !== hivewarddManagedStopRequestKey(request)) {
    throw new Error('hivewardd_stop_receipt_mismatch')
  }
  return receipt
}

function writeReceipt(request: HivewarddManagedStopRequest, kind: ReceiptKind, receipt: unknown): void {
  if (!writeDurableSecureJsonFile(hivewarddStopReceiptPath(request, kind), receipt)) {
    throw new Error('hivewardd_stop_receipt_permissions_unconfirmed')
  }
}

export function readHivewarddCompletedStopReceipt(
  request: HivewarddManagedStopRequest
): HivewarddCompletedStopReceipt | null {
  return readHivewarddStopReceipt(request, 'completed', HivewarddCompletedStopReceiptSchema)
}

/** Persist only after proven exit and fsync even existing receipts.
 * Missing retirement records remain unverifiable. */
export function persistHivewarddCompletedStopReceipt(
  request: HivewarddManagedStopRequest,
  exitedAt: Date
): HivewarddCompletedStopReceipt {
  const parsed = HivewarddManagedStopRequestSchema.parse(request)
  const retirement = parsed.retireIdleDaemon
    ? (readHivewarddDaemonRetirementRecord(parsed)?.retirement ?? 'unverifiable')
    : undefined
  const receipt = readHivewarddCompletedStopReceipt(parsed) ?? {
    schemaVersion: 1 as const,
    kind: 'hivewardd_managed_stop_completed' as const,
    request: parsed,
    exitedAt: exitedAt.toISOString(),
    ...(retirement ? { retirement } : {})
  }
  writeReceipt(parsed, 'completed', receipt)
  return receipt
}

export function readHivewarddDaemonRetirementRecord(
  request: HivewarddManagedStopRequest
): HivewarddDaemonRetirementRecord | null {
  return readHivewarddStopReceipt(request, 'retirement', HivewarddDaemonRetirementRecordSchema)
}

export function persistHivewarddDaemonRetirementRecord(
  request: HivewarddManagedStopRequest,
  outcome: Pick<HivewarddDaemonRetirementRecord, 'retirement' | 'liveSessions' | 'reason'>
): void {
  writeReceipt(request, 'retirement', {
    schemaVersion: 1,
    kind: 'hivewardd_managed_stop_retirement',
    request: HivewarddManagedStopRequestSchema.parse(request),
    // Name fields explicitly; extra in-process fields would fail the strict schema.
    retirement: outcome.retirement,
    liveSessions: outcome.liveSessions,
    reason: outcome.reason
  })
}
