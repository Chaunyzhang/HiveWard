// Journal instance-bound stop under the activation fence; refuse live/unknown terminal census and deactivate only after proven exit.
import { randomUUID } from 'node:crypto'
import type { HivewarddActivationRecord } from '../activation/hivewardd-activation-record'
import {
  readHivewarddActivationRecord,
  writeHivewarddActivationRecord
} from '../activation/hivewardd-activation-record-store'
import { sameHivewarddActivationRecord } from '../activation/hivewardd-activation-transaction'
import { writeHivewarddActivationTransaction } from '../activation/hivewardd-activation-transaction-store'
import { withHivewarddActivationLock } from '../activation/hivewardd-activation-lock'
import { hivewarddActivationFenceRefusal } from '../activation/hivewardd-activation-fence-hold'
import {
  committedHivewarddDecommissionRecord,
  createHivewarddDecommissionTransaction,
  withHivewarddDecommissionProcessExited,
  withHivewarddDecommissionStopDispatched
} from '../lifecycle/hivewardd-decommission-transaction'
import { readRemoteHivewarddManagedStopTarget } from '../lifecycle/hivewardd-managed-remote-stop'
import { settleHivewarddDecommissionStop } from '../lifecycle/hivewardd-decommission-stop'
import type { HivewarddSlotOptions } from '../../ssh/hivewardd-recovery-slot'
import type { HivewarddDecommissionResult } from '../../../shared/hivewardd-decommission'
import type { HivewarddTerminalCensus } from '../../../shared/hivewardd-terminal-census'

type HivewarddDecommissionOptions = HivewarddSlotOptions & {
  /** Refuse if the host record changed since caller review. */
  record: HivewarddActivationRecord
  /** Fresh census must prove no live or uncounted terminals. */
  census: HivewarddTerminalCensus
  now?: () => Date
}

type Refusal = Extract<HivewarddDecommissionResult, { outcome: 'refused' }>

function refuse(verdict: Refusal['verdict'], code: string, reason: string): Refusal {
  return { outcome: 'refused', verdict, code, reason }
}

function censusRefusal(census: HivewarddTerminalCensus): Refusal | null {
  if (census.liveSessions === null) {
    return refuse(
      'unverifiable',
      'hivewardd_decommission_census_unavailable',
      'The terminal daemon did not answer a session count, so decommissioning could end ' +
        'running work. Retry when the host answers.'
    )
  }
  if (census.liveSessions > 0) {
    return refuse(
      'live',
      'hivewardd_decommission_terminals_running',
      `${census.liveSessions} terminal${census.liveSessions === 1 ? ' is' : 's are'} still ` +
        'running on this host. Close them before decommissioning the server.'
    )
  }
  return null
}

export async function decommissionRemoteHivewardd(
  options: HivewarddDecommissionOptions
): Promise<HivewarddDecommissionResult> {
  const now = options.now ?? ((): Date => new Date())
  return withHivewarddActivationLock(
    options,
    async (lock) => {
      const record = await readHivewarddActivationRecord(options)
      if (!sameHivewarddActivationRecord(record, options.record)) {
        return refuse(
          'unverifiable',
          'hivewardd_decommission_record_changed',
          'The host activation record changed since it was reviewed. Refresh and try again.'
        )
      }
      const activeVersion = record.active
      if (!activeVersion) {
        return refuse(
          'unverifiable',
          'hivewardd_decommission_nothing_active',
          'No hivewardd version is active on this host, so there is nothing to decommission.'
        )
      }
      const census = censusRefusal(options.census)
      if (census) {
        return census
      }
      const target = await readRemoteHivewarddManagedStopTarget(options, activeVersion)
      if (target.state === 'refused') {
        return refuse(target.verdict, target.code, target.reason)
      }

      let transaction = createHivewarddDecommissionTransaction({
        transactionId: randomUUID(),
        recordBefore: { ...record, active: activeVersion },
        now: now()
      })
      await writeHivewarddActivationTransaction(options, transaction)
      lock.retainOnError()
      const request = {
        schemaVersion: 1 as const,
        transactionId: transaction.transactionId,
        ...target.context,
        // Idle daemon retirement is best-effort; busy daemons retain their terminals.
        retireIdleDaemon: true as const
      }
      // Journal exact stop intent before dispatch so recovery can settle the same request.
      transaction = withHivewarddDecommissionStopDispatched(transaction, request, now())
      await writeHivewarddActivationTransaction(options, transaction)

      const settlement = await settleHivewarddDecommissionStop(options, request)
      if (settlement.state === 'withdrawn') {
        return refuse(settlement.verdict, 'hivewardd_decommission_stop_withdrawn', settlement.reason)
      }
      if (settlement.state === 'unsettled') {
        lock.retain()
        return refuse(settlement.verdict, 'hivewardd_decommission_stop_unsettled', settlement.reason)
      }
      transaction = withHivewarddDecommissionProcessExited(transaction, now())
      await writeHivewarddActivationTransaction(options, transaction)
      await writeHivewarddActivationRecord(options, committedHivewarddDecommissionRecord(transaction))
      return {
        outcome: 'decommissioned',
        version: activeVersion,
        retirement: settlement.retirement
      }
    },
    async () => {
      const refusal = await hivewarddActivationFenceRefusal(options, 'stop')
      return refuse('unverifiable', refusal.code, refusal.reason)
    }
  )
}
