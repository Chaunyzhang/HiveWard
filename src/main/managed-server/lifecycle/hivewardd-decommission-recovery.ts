import { writeHivewarddActivationRecord } from '../activation/hivewardd-activation-record-store'
import type { HivewarddActivationRecoveryResult } from '../activation/hivewardd-activation-recovery'
import type { HivewarddDecommissionRecoveryPlan } from './hivewardd-decommission-transaction'
import { settleHivewarddDecommissionStop } from './hivewardd-decommission-stop'
import {
  hivewarddLivenessProbeCommand,
  hivewarddLivenessProvenExited,
  parseHivewarddLiveness
} from '../install/hivewardd-remote-launch'
import { execHivewarddRemote } from '../install/hivewardd-remote-runtime-control'
import {
  ensureHivewarddSlotServing,
  hivewarddSlotDir,
  resolveHivewarddSlotIdentity,
  type HivewarddSlotOptions
} from '../../ssh/hivewardd-recovery-slot'

/** Only proven exit clears an interrupted decommission journal. */
export async function reconcileHivewarddDecommission(
  options: HivewarddSlotOptions,
  plan: HivewarddDecommissionRecoveryPlan
): Promise<HivewarddActivationRecoveryResult> {
  if (plan.action === 'keep-serving') {
    const identity = await resolveHivewarddSlotIdentity(options, plan.version)
    return {
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: plan.version,
      readiness: await ensureHivewarddSlotServing(options, identity)
    }
  }
  if (plan.action === 'resume-stop') {
    const settlement = await settleHivewarddDecommissionStop(options, plan.request)
    if (settlement.state === 'unsettled') {
      return {
        outcome: 'refused',
        verdict: settlement.verdict,
        code: 'hivewardd_recovery_decommission_unsettled',
        reason: settlement.reason
      }
    }
    if (settlement.state === 'withdrawn') {
      return reconcileHivewarddDecommission(options, {
        action: 'keep-serving',
        version: plan.request.version
      })
    }
    return reconcileHivewarddDecommission(options, {
      action: 'confirm-decommissioned',
      version: plan.request.version,
      record: plan.record
    })
  }
  // Live or unanswered slots retain the fence; only proven exit permits commit.
  const liveness = parseHivewarddLiveness(
    await execHivewarddRemote(
      options,
      hivewarddLivenessProbeCommand(options.host, hivewarddSlotDir(options, plan.version))
    )
  )
  if (!hivewarddLivenessProvenExited(liveness)) {
    return {
      outcome: 'refused',
      verdict: liveness === 'LIVE' ? 'live' : 'unverifiable',
      code: 'hivewardd_recovery_decommissioned_slot_not_exited',
      reason: `hivewardd ${plan.version} is recorded as stopped but is ${liveness.toLowerCase()}.`
    }
  }
  if (plan.record) {
    await writeHivewarddActivationRecord(options, plan.record)
  }
  return { outcome: 'recovered', resolution: 'committed', activeVersion: null, readiness: null }
}
