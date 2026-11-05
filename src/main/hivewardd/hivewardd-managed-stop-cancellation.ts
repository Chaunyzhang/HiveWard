import { rmSync } from 'node:fs'
import type {
  HivewarddManagedStopCancellation,
  HivewarddManagedStopRequest
} from '../../shared/hivewardd-stop-request'
import { claimHivewarddManagedStopDecision } from './hivewardd-managed-stop-decision'
import {
  hivewarddManagedStopRequestPath,
  readHivewarddManagedStopRequest
} from './hivewardd-managed-stop-request'

/** Dispatched stops cannot be canceled; their completion verdict remains authoritative. */
export function cancelHivewarddManagedStop(
  request: HivewarddManagedStopRequest
): HivewarddManagedStopCancellation['outcome'] {
  const outcome = claimHivewarddManagedStopDecision(request, 'canceled')
  if (outcome === 'canceled') {
    withdrawHivewarddManagedStopRequest(request)
  }
  return outcome
}

export function withdrawHivewarddManagedStopRequest(request: HivewarddManagedStopRequest): void {
  const path = hivewarddManagedStopRequestPath(request.instance)
  try {
    if (readHivewarddManagedStopRequest(path).transactionId === request.transactionId) {
      rmSync(path, { force: true })
    }
  } catch {
    // The persisted decision fences this transaction even if its request is gone.
  }
}
