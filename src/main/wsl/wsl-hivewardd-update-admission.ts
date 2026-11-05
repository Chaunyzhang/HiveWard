/** Reuse SSH update admission: keep newer, rolled-back or launch-rejected incumbents serving; fenced activation replans before committing. */
import {
  HIVEWARDD_HOST_NEWER_DEFERRAL_CODE,
  HIVEWARDD_UPDATE_WSL_MOVE_RUNNING_CODE,
  type WslHostDeferredUpdate
} from '../../shared/wsl-host-types'
import { refuseHivewarddHostDowngrade } from '../ssh/hivewardd-host-version-admission'
import type { ServeReadiness } from '../server/serve-readiness'
import type { HivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'
import { readHivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record-store'
import { readHivewarddActivationTransaction } from '../managed-server/activation/hivewardd-activation-transaction-store'
import { isWaitingHivewarddUpdateDeferral } from '../managed-server/lifecycle/hivewardd-managed-auto-update'
import {
  hivewarddUpdateSkipRefusal,
  planHivewarddUpdateForIntent,
  type ManagedHivewarddAutoUpdatePlan,
  type HivewarddUpdateIntent
} from '../managed-server/lifecycle/hivewardd-managed-update-decision'
import {
  hivewarddUpdateFailureThisLaunch,
  recordHivewarddUpdateFailedThisLaunch,
  type HivewarddUpdateFailure,
  type HivewarddUpdateFailureHost
} from '../managed-server/lifecycle/hivewardd-managed-update-failure-memory'
import { HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE } from '../ssh/hivewardd-installed-activation'
import type { HivewarddSlotOptions } from '../ssh/hivewardd-recovery-slot'
import { adoptRunningHivewarddVersion } from '../ssh/hivewardd-running-version-adoption'
import type { WslHivewarddLaunch } from './wsl-hivewardd-deploy'

type WslHivewarddReadyLaunch = Extract<WslHivewarddLaunch, { outcome: 'ready' }>

export type WslHivewarddUpdateAdmission =
  | {
      action: 'serve'
      version: string
      readiness: ServeReadiness
      deferredUpdate: WslHostDeferredUpdate | null
    }
  /** Another run holds the host fence; a later connect adopts or deploys. */
  | { action: 'defer'; deferredUpdate: WslHostDeferredUpdate }
  /** Deploy this app's build on this record. */
  | { action: 'deploy'; record: HivewarddActivationRecord }

export async function admitWslHivewarddUpdate(args: {
  slot: HivewarddSlotOptions
  record: HivewarddActivationRecord
  candidateVersion: string
  appVersion: string
  host: HivewarddUpdateFailureHost
  intent: HivewarddUpdateIntent
  /** A project move to this distro runs here: a redeploy would cut it off, even when forced. */
  moveRunning?: boolean
}): Promise<WslHivewarddUpdateAdmission> {
  const { record, candidateVersion, appVersion } = args
  if (!record.active) {
    return { action: 'deploy', record }
  }
  const failure = hivewarddUpdateFailureThisLaunch(args.host)
  const plan = planHivewarddUpdateForIntent(args.intent, {
    record,
    candidateVersion,
    appVersion,
    failedBefore: failure !== null
  })
  const heldForMove = args.moveRunning === true && plan.action === 'update'
  if (!heldForMove && (plan.action !== 'skip' || plan.reason === 'current')) {
    return { action: 'deploy', record }
  }
  const adopted = await adoptRunningHivewarddVersion(args.slot, record, candidateVersion)
  if (!adopted) {
    // Nothing active any more: deploy on the record the wake read; its fenced admission re-plans.
    return { action: 'deploy', record: await readHivewarddActivationRecord(args.slot) }
  }
  if ('outcome' in adopted) {
    const { candidateVersion: version, code, reason, forceable } = adopted
    return {
      action: 'defer',
      deferredUpdate: { candidateVersion: version, code, reason, forceable: forceable === true }
    }
  }
  return {
    action: 'serve',
    version: adopted.version,
    readiness: adopted.readiness,
    deferredUpdate:
      adopted.version === candidateVersion
        ? null
        : heldForMove
          ? {
              candidateVersion,
              code: HIVEWARDD_UPDATE_WSL_MOVE_RUNNING_CODE,
              reason:
                'A project is moving to this WSL host; its server updates once the move finishes.',
              forceable: false
            }
          : skippedUpdateHint(plan, failure, record, candidateVersion, appVersion)
  }
}

/** The launch an admission ends in, or the record to deploy on. */
export async function admitWslHivewarddLaunch(
  args: Parameters<typeof admitWslHivewarddUpdate>[0],
  distro: string,
  readyLaunch: (serving: {
    fullVersion: string
    readiness: ServeReadiness
  }) => Promise<WslHivewarddReadyLaunch>
): Promise<WslHivewarddLaunch | HivewarddActivationRecord> {
  const admission = await admitWslHivewarddUpdate(args)
  if (admission.action === 'deploy') {
    return admission.record
  }
  if (admission.action === 'defer') {
    return { outcome: 'deferred', distro, ...admission.deferredUpdate }
  }
  const ready = await readyLaunch({
    fullVersion: admission.version,
    readiness: admission.readiness
  })
  return admission.deferredUpdate ? { ...ready, deferredUpdate: admission.deferredUpdate } : ready
}

/** Offer Update/Force for retriable host deferrals; newer hosts get no hint because Update cannot change that refusal. */
function skippedUpdateHint(
  plan: ManagedHivewarddAutoUpdatePlan,
  failure: HivewarddUpdateFailure | null,
  record: HivewarddActivationRecord,
  candidateVersion: string,
  appVersion: string
): WslHostDeferredUpdate | null {
  if (plan.action !== 'skip') {
    return null
  }
  if (plan.reason === 'failed-before' && failure) {
    return { candidateVersion, ...failure, forceable: true }
  }
  const refusal =
    plan.reason === 'rolled-back'
      ? hivewarddUpdateSkipRefusal(plan, record, candidateVersion, appVersion)
      : null
  return refusal
    ? {
        candidateVersion,
        code: HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE,
        reason: refusal,
        forceable: true
      }
    : null
}

/** Do not retry rejected/thrown incumbent updates this launch, matching SSH. Waits/policy refusals never attempted activation and record no failure. */
export function recordWslHivewarddUpdateFailure(
  host: HivewarddUpdateFailureHost,
  incumbentVersion: string | null,
  failure: HivewarddUpdateFailure | null
): void {
  if (incumbentVersion && failure) {
    recordHivewarddUpdateFailedThisLaunch(host, failure)
  }
}

export function wslHivewarddDeferralFailure(deployed: {
  code: string
  reason: string
}): HivewarddUpdateFailure | null {
  return isWaitingHivewarddUpdateDeferral(deployed.code) ||
    deployed.code === HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE
    ? null
    : { code: deployed.code, reason: deployed.reason }
}

/** A policy refusal over a host a newer HiveWard runs gets its own code: an Update cannot pass it. */
export async function wslHivewarddDeferralCode(
  slot: HivewarddSlotOptions,
  deployed: { code: string; fullVersion: string },
  appVersion: string
): Promise<string> {
  if (deployed.code !== HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE) {
    return deployed.code
  }
  const record = await readHivewarddActivationRecord(slot).catch(() => null)
  return record && refuseHivewarddHostDowngrade(record, deployed.fullVersion, appVersion)
    ? HIVEWARDD_HOST_NEWER_DEFERRAL_CODE
    : deployed.code
}

/** The record only once the incumbent is back and no journal awaits recovery; else null. */
export async function readRestoredWslHivewarddRecord(
  slot: HivewarddSlotOptions,
  incumbent: string
): Promise<HivewarddActivationRecord | null> {
  // Unreadable transaction state proves no restoration; preserve the rejection.
  if (await readHivewarddActivationTransaction(slot).catch(() => true)) {
    return null
  }
  const record = await readHivewarddActivationRecord(slot).catch(() => null)
  return record?.active === incumbent ? record : null
}
