// Exclusive hard links arbitrate stop versus cancel; cancel cannot succeed once dispatch wins.
import { linkSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  HivewarddManagedStopDecisionSchema,
  HivewarddManagedStopRequestSchema,
  type HivewarddManagedStopDecision,
  type HivewarddManagedStopRequest
} from '../../shared/hivewardd-stop-request'
import { hivewarddStopReceiptPath, readHivewarddStopReceipt } from './hivewardd-completed-stop-receipt'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

type HivewarddManagedStopDecisionValue = HivewarddManagedStopDecision['decision']

export function readHivewarddManagedStopDecision(
  request: HivewarddManagedStopRequest
): HivewarddManagedStopDecisionValue | null {
  return readHivewarddStopReceipt(request, 'decision', HivewarddManagedStopDecisionSchema)?.decision ?? null
}

export function claimHivewarddManagedStopDecision(
  input: HivewarddManagedStopRequest,
  decision: HivewarddManagedStopDecisionValue
): HivewarddManagedStopDecisionValue {
  const request = HivewarddManagedStopRequestSchema.parse(input)
  const path = hivewarddStopReceiptPath(request, 'decision')
  const staged = `${path}.${process.pid}.${randomUUID()}.staged`
  const record: HivewarddManagedStopDecision = {
    schemaVersion: 1,
    kind: 'hivewardd_managed_stop_decision',
    request,
    decision
  }
  if (!writeDurableSecureJsonFile(staged, record)) {
    rmSync(staged, { force: true })
    throw new Error('hivewardd_managed_stop_decision_permissions_unconfirmed')
  }
  try {
    linkSync(staged, path)
    return decision
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error
    }
    const standing = readHivewarddManagedStopDecision(request)
    if (!standing) {
      throw new Error('hivewardd_managed_stop_decision_unverifiable')
    }
    return standing
  } finally {
    rmSync(staged, { force: true })
  }
}
