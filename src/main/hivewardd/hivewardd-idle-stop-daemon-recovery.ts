// Cancelled idle stops may leave daemon admission closed. Replace only after atomic retirement
// agreement: replacement could otherwise kill the old daemon’s live sessions.
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { HivewarddDaemonRetirement } from './hivewardd-daemon-retirement'
import { HIVEWARDD_DAEMON_RETIREMENT_TIMEOUT_MS } from './hivewardd-stop-deadlines'

type RetirementOutcome = Pick<HivewarddDaemonRetirement, 'retirement' | 'lateRetirement'>

type HivewarddIdleStopDaemonRecoveryPorts = {
  admissionClosed: () => boolean
  /** Atomically recheck census and retirement fence in the daemon. */
  retireAgain: () => Promise<RetirementOutcome>
  replaceDaemon: () => Promise<unknown>
  timeoutMs?: number
}

export async function recoverDaemonAfterCancelledIdleStop(
  outcome: RetirementOutcome,
  ports: HivewarddIdleStopDaemonRecoveryPorts
): Promise<'serving' | 'unservable'> {
  const timeoutMs = ports.timeoutMs ?? HIVEWARDD_DAEMON_RETIREMENT_TIMEOUT_MS
  const retired = async (candidate: RetirementOutcome): Promise<boolean> =>
    candidate.retirement === 'retired' ||
    (candidate.lateRetirement !== undefined &&
      (await withTimeout(candidate.lateRetirement, timeoutMs, false)))
  if (!(await retired(outcome))) {
    if (!ports.admissionClosed()) {
      return 'serving'
    }
    // Only the daemon can resolve a lost retirement reply.
    const retry = await ports
      .retireAgain()
      .catch((): RetirementOutcome => ({ retirement: 'unverifiable' }))
    if (!(await retired(retry))) {
      if (ports.admissionClosed()) {
        console.error('[hivewardd] the terminal daemon may be retiring and did not settle it')
        return 'unservable'
      }
      return 'serving'
    }
  }
  try {
    await ports.replaceDaemon()
    console.error('[hivewardd] a client returned during idle stop; started a fresh terminal daemon')
    return 'serving'
  } catch (error) {
    console.error('[hivewardd] could not replace the retired terminal daemon:', error)
    return 'unservable'
  }
}
