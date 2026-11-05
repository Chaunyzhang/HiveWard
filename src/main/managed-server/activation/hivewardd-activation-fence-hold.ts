/** Retry live fences later, clear abandoned bare fences, and require recovery for interrupted journaled state. */
import {
  hivewarddActivationFenceExists,
  withStaleHivewarddActivationRecoveryLock,
  type HivewarddActivationLockOptions
} from './hivewardd-activation-lock'
import { readHivewarddActivationTransaction } from './hivewardd-activation-transaction-store'
import { hivewarddActivationFenceLockDir } from './hivewardd-activation-transaction'
import { isRelayInstallLockStale } from '../install/remote-install-lock'
import { findExitedOwnLockToken } from '../../ssh/hivewardd-exited-own-lock'
import { hivewarddRemoteBaseDir } from '../install/hivewardd-remote-windows-node'

export const HIVEWARDD_ACTIVATION_FENCE_BUSY_CODE = 'hivewardd_activation_fence_busy'
const HIVEWARDD_ACTIVATION_RECOVERY_REQUIRED_CODE = 'hivewardd_activation_recovery_required'

type HivewarddActivationFenceRefusal = {
  code: string
  reason: string
  /** Bare stale fence cleared; the caller may retry immediately. */
  cleared?: true
}

export async function hivewarddActivationFenceRefusal(
  options: HivewarddActivationLockOptions,
  attempt: string
): Promise<HivewarddActivationFenceRefusal> {
  const lockDir = hivewarddActivationFenceLockDir(options.host, options.remoteHome)
  const journal = (await readHivewarddActivationTransaction(options).catch(() => null)) !== null
  const baseDir = hivewarddRemoteBaseDir(options.host, options.remoteHome)
  const stale =
    (await findExitedOwnLockToken(options, lockDir, { baseDir, guardsStateMutation: true })) !==
      null || (await isRelayInstallLockStale(options.conn, lockDir, options.host))
  if (stale && !journal && (await clearAbandonedFence(options))) {
    return {
      code: HIVEWARDD_ACTIVATION_FENCE_BUSY_CODE,
      reason: `An abandoned fence held this host and was cleared; the ${attempt} is retried.`,
      cleared: true
    }
  }
  const stuck = stale || (journal && !(await hivewarddActivationFenceExists(options).catch(() => true)))
  return stuck
    ? {
        code: HIVEWARDD_ACTIVATION_RECOVERY_REQUIRED_CODE,
        reason: `An interrupted update or stop holds this host, so the ${attempt} did not start. Recover it first.`
      }
    : {
        code: HIVEWARDD_ACTIVATION_FENCE_BUSY_CODE,
        reason: `Another run is changing this host’s HiveWard server, so the ${attempt} did not start. It is retried on a later connect.`
      }
}

/** Drop a stale fence only after rechecking under takeover that no journal appeared. */
async function clearAbandonedFence(options: HivewarddActivationLockOptions): Promise<boolean> {
  try {
    return await withStaleHivewarddActivationRecoveryLock(options, async (lock) => {
      if (await readHivewarddActivationTransaction(options)) {
        lock.retain()
        return false
      }
      return true
    })
  } catch {
    // Failed takeover leaves the fence intact for normal refusal classification.
    return false
  }
}
