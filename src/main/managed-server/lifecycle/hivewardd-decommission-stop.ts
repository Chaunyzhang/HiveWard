// Lost stop answers are unverifiable; only confirmed exit or cancellation releases the fence.
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import {
  cancelRemoteHivewarddManagedStop,
  completeRemoteHivewarddManagedStop
} from './hivewardd-managed-remote-stop'
import type { HivewarddSlotOptions } from '../../ssh/hivewardd-recovery-slot'
import type {
  HivewarddDaemonRetirementVerdict,
  HivewarddManagedStopRequest
} from '../../../shared/hivewardd-stop-request'
import { errorMessage } from '../../../shared/error-message'

type HivewarddDecommissionStopSettlement =
  | { state: 'exited'; retirement: HivewarddDaemonRetirementVerdict }
  /** Confirmed cancellation leaves the incumbent serving. */
  | { state: 'withdrawn'; verdict: 'live' | 'unverifiable'; reason: string }
  /** Stop underway or unconfirmed; retain the fence. */
  | { state: 'unsettled'; verdict: 'live' | 'unverifiable'; reason: string }

export async function settleHivewarddDecommissionStop(
  options: HivewarddSlotOptions,
  request: HivewarddManagedStopRequest
): Promise<HivewarddDecommissionStopSettlement> {
  let verdict: 'live' | 'unverifiable'
  let reason: string
  try {
    const completion = await completeRemoteHivewarddManagedStop(options, request)
    if (completion.verdict === 'exited') {
      // A completion without a recorded outcome proves exit but not retirement.
      return { state: 'exited', retirement: completion.retirement ?? 'unverifiable' }
    }
    verdict = completion.verdict
    reason = `hivewardd ${request.version} did not exit (${completion.verdict}).`
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    verdict = 'unverifiable'
    reason = `The host gave no verifiable stop verdict: ${errorMessage(error)}`
  }
  try {
    const cancellation = await cancelRemoteHivewarddManagedStop(options, request)
    if (cancellation.outcome === 'canceled') {
      return {
        state: 'withdrawn',
        verdict,
        reason: `${reason} The stop request was withdrawn; hivewardd keeps serving.`
      }
    }
    return {
      state: 'unsettled',
      verdict: 'live',
      reason: `${reason} hivewardd already acted on the request and is still stopping.`
    }
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return {
      state: 'unsettled',
      verdict: 'unverifiable',
      reason: `${reason} Withdrawing the request gave no verifiable answer: ${errorMessage(error)}`
    }
  }
}
