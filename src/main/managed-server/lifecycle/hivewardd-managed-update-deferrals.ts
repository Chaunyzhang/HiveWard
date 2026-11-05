import type { HivewarddManagedDeferral } from '../../../shared/hivewardd-managed-runtime'
import { compareAppVersions } from '../../../shared/app-version'

type RecordedDeferral = HivewarddManagedDeferral & { deferredAt: string }

const deferrals = new Map<string, RecordedDeferral>()

export function recordManagedHivewarddUpdateDeferral(
  environmentId: string,
  deferral: HivewarddManagedDeferral,
  now = new Date()
): void {
  deferrals.set(environmentId, { ...deferral, deferredAt: now.toISOString() })
}

export function clearManagedHivewarddUpdateDeferral(environmentId: string): void {
  deferrals.delete(environmentId)
}

function readManagedHivewarddUpdateDeferral(environmentId: string): RecordedDeferral | null {
  return deferrals.get(environmentId) ?? null
}

/** Forget deferrals resolved by another desktop activating the candidate or a newer release. */
export function currentManagedHivewarddUpdateDeferral(
  environmentId: string,
  activeVersion: string | null
): RecordedDeferral | null {
  const deferral = readManagedHivewarddUpdateDeferral(environmentId)
  if (
    deferral &&
    activeVersion &&
    (activeVersion === deferral.candidateVersion ||
      compareAppVersions(activeVersion, deferral.candidateVersion) > 0)
  ) {
    clearManagedHivewarddUpdateDeferral(environmentId)
    return null
  }
  return deferral
}
