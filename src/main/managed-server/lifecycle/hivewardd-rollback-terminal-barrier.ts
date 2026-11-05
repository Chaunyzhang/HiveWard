// Pre-stop census can go stale; only fenced idle-daemon retirement proves snapshot replacement safe.
import {
  readRemoteHivewarddManagedStopTarget,
  type HivewarddManagedStopTarget
} from './hivewardd-managed-remote-stop'
import { settleHivewarddDecommissionStop } from './hivewardd-decommission-stop'
import type { HivewarddSlotOptions } from '../../ssh/hivewardd-recovery-slot'
import type { HivewarddManagedStopContext } from '../../../shared/hivewardd-stop-request'

type HivewarddRollbackBarrier =
  | { state: 'retired' }
  | { state: 'withdrawn'; reason: string }
  /** Stop underway or unconfirmed; retain the fence. */
  | { state: 'unsettled'; reason: string }
  /** Exit without proof of idle terminals requires restarting the incumbent. */
  | { state: 'unproven'; reason: string }

export async function readHivewarddRollbackBarrierTarget(
  options: HivewarddSlotOptions,
  version: string
): Promise<HivewarddManagedStopTarget> {
  const target = await readRemoteHivewarddManagedStopTarget(options, version)
  return target.state === 'ready'
    ? target
    : {
        ...target,
        code: 'hivewardd_rollback_terminal_barrier_unavailable',
        reason:
          `${target.reason} A rollback needs hivewardd to prove no terminal runs at its stop; ` +
          'nothing was changed.'
      }
}

export async function stopIncumbentBehindTerminalBarrier(
  options: HivewarddSlotOptions,
  transactionId: string,
  context: HivewarddManagedStopContext
): Promise<HivewarddRollbackBarrier> {
  const settlement = await settleHivewarddDecommissionStop(options, {
    schemaVersion: 1,
    transactionId,
    ...context,
    retireIdleDaemon: true
  })
  if (settlement.state === 'withdrawn' || settlement.state === 'unsettled') {
    return { state: settlement.state, reason: settlement.reason }
  }
  if (settlement.retirement === 'retired') {
    return { state: 'retired' }
  }
  return {
    state: 'unproven',
    reason:
      `hivewardd ${context.version} stopped, but its terminal daemon reported ` +
      `${settlement.retirement} work at the stop, so the older snapshot was not restored.`
  }
}

type HivewarddRollbackBarrierRefusal = {
  outcome: 'refused' | 'failed'
  code: string
  reason: string
  retainFence: boolean
  restartIncumbent: boolean
}

/** Only retired daemons permit replacing current state with an older snapshot. */
export function rollbackBarrierRefusal(
  barrier: HivewarddRollbackBarrier
): HivewarddRollbackBarrierRefusal | null {
  switch (barrier.state) {
    case 'retired':
      return null
    case 'withdrawn':
      return {
        outcome: 'failed',
        code: 'hivewardd_rollback_stop_withdrawn',
        reason: barrier.reason,
        retainFence: false,
        restartIncumbent: false
      }
    case 'unsettled':
      return {
        outcome: 'failed',
        code: 'hivewardd_rollback_stop_incomplete',
        reason: `${barrier.reason} Nothing was restored.`,
        retainFence: true,
        restartIncumbent: false
      }
    case 'unproven':
      return {
        outcome: 'refused',
        code: 'hivewardd_rollback_terminals_at_stop',
        reason: barrier.reason,
        retainFence: false,
        restartIncumbent: true
      }
  }
}
