import { isValidAppVersion } from '../../../shared/app-version'
import type { HivewarddActivationRecord } from '../activation/hivewardd-activation-record'
import {
  refuseHivewarddHostDowngrade,
  type HivewarddHostVersionRefusal
} from '../../ssh/hivewardd-host-version-admission'

export type ManagedHivewarddAutoUpdateSkip =
  | 'current'
  | 'no-template'
  | 'rolled-back'
  | 'failed-before'
  | 'migrating'
  | HivewarddHostVersionRefusal

/** Connect honors all skips; Update retries local failures/rollbacks; Force also lifts version skips. */
export type HivewarddUpdateIntent = 'connect' | 'update' | 'force'

export type ManagedHivewarddAutoUpdatePlan =
  | { action: 'update' }
  | { action: 'skip'; reason: ManagedHivewarddAutoUpdateSkip }

export function planManagedHivewarddAutoUpdate(input: {
  record: HivewarddActivationRecord
  candidateVersion: string | null
  appVersion: string
  failedBefore: boolean
}): ManagedHivewarddAutoUpdatePlan {
  const { record, candidateVersion } = input
  if (!candidateVersion) {
    return { action: 'skip', reason: 'no-template' }
  }
  const refusal = refuseHivewarddHostDowngrade(record, candidateVersion, input.appVersion)
  if (refusal && refusal !== 'host-newer') {
    return { action: 'skip', reason: refusal }
  }
  if (record.active === candidateVersion) {
    return { action: 'skip', reason: 'current' }
  }
  if (record.rolledBackFrom === candidateVersion) {
    return { action: 'skip', reason: 'rolled-back' }
  }
  if (refusal) {
    return { action: 'skip', reason: refusal }
  }
  // A stopped host has no serving fallback; retry even after a prior failed attempt.
  if (record.active === null && record.previous !== null) {
    return { action: 'update' }
  }
  return input.failedBefore ? { action: 'skip', reason: 'failed-before' } : { action: 'update' }
}

export function planHivewarddUpdateForIntent(
  intent: HivewarddUpdateIntent,
  input: Parameters<typeof planManagedHivewarddAutoUpdate>[0]
): ManagedHivewarddAutoUpdatePlan {
  if (intent === 'force') {
    const refusal = refuseHivewarddHostDowngrade(
      input.record,
      input.candidateVersion ?? '',
      input.appVersion
    )
    return refusal && refusal !== 'host-newer'
      ? { action: 'skip', reason: refusal }
      : { action: 'update' }
  }
  if (intent === 'connect') {
    return planManagedHivewarddAutoUpdate(input)
  }
  const { rolledBackFrom: _retried, ...record } = input.record
  return planManagedHivewarddAutoUpdate({ ...input, record, failedBefore: false })
}

export function admitHivewarddRecordForIntent(
  intent: HivewarddUpdateIntent,
  appVersion: string
): (record: HivewarddActivationRecord, candidateVersion: string) => string | null {
  return (record, candidateVersion) =>
    hivewarddUpdateSkipRefusal(
      planHivewarddUpdateForIntent(intent, {
        record,
        candidateVersion,
        appVersion,
        failedBefore: false
      }),
      record,
      candidateVersion,
      appVersion
    )
}

export function hivewarddUpdateSkipRefusal(
  plan: ManagedHivewarddAutoUpdatePlan,
  record: HivewarddActivationRecord,
  candidateVersion: string,
  appVersion: string
): string | null {
  if (plan.action !== 'skip' || plan.reason === 'current') {
    return null
  }
  if (plan.reason === 'host-other-product' || plan.reason === 'host-identity-unverified') {
    return '无法确认主机上的服务属于 HiveWard，已保留原安装。'
  }
  return plan.reason === 'rolled-back'
    ? `This host's server rolled back from ${candidateVersion}, so a connect does not activate ` +
        'it again; choose Update or Force to retry it.'
    : `HiveWard ${record.activeAppVersion} last ran this host's server, newer than this ` +
        `HiveWard (${appVersion}). Update HiveWard to start it.`
}

/** Content hashes cannot order updates: compare HiveWard versions, or for legacy hosts offer only this desktop's previously deferred build. */
export function availableManagedHivewarddUpdate(input: {
  record: HivewarddActivationRecord
  candidateVersion: string | null
  appVersion: string
  /** The build this desktop's last Update or connect deferred on this host. */
  deferredCandidateVersion: string | null
}): string | null {
  const { record, candidateVersion, appVersion } = input
  const hostAppVersion = record.activeAppVersion
  if (!candidateVersion || record.active === null || !isValidAppVersion(appVersion)) {
    return null
  }
  const ordered = hostAppVersion
    ? isValidAppVersion(hostAppVersion) &&
      refuseHivewarddHostDowngrade(record, candidateVersion, appVersion) === null
    : input.deferredCandidateVersion === candidateVersion
  if (!ordered) {
    return null
  }
  // Connect rules: a build the user rolled back from is not advertised again.
  const plan = planManagedHivewarddAutoUpdate({
    record,
    candidateVersion,
    appVersion,
    failedBefore: false
  })
  return plan.action === 'update' ? candidateVersion : null
}
