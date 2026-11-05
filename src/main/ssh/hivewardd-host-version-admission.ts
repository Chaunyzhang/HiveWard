/** Reject activation over state a newer host build may already have migrated. */
import { compareAppVersions } from '../../shared/app-version'
import { profileStateBuildCompatibilityError } from '../../shared/profile-state-build-compatibility'
import type { HivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'

export type HivewarddHostVersionRefusal =
  | 'host-newer'
  | 'host-other-product'
  | 'host-identity-unverified'

export function refuseHivewarddHostDowngrade(
  record: HivewarddActivationRecord,
  candidateVersion: string,
  appVersion: string
): HivewarddHostVersionRefusal | null {
  const identityRefusal = refuseHivewarddHostIdentity(record)
  if (identityRefusal) {
    return identityRefusal
  }
  if (profileStateBuildCompatibilityError(record.activeAppVersion ?? appVersion, appVersion)) {
    return 'host-newer'
  }
  // 只有已核实产品身份的继承版号可以重置，未来正式版 1.4.214 仍按正常顺序比较。
  if (
    record.activeProduct === 'HiveWard' &&
    record.activeVersionFamily === 'inherited' &&
    compareAppVersions(appVersion, '1.0.0') >= 0
  ) {
    return null
  }
  // Restarting the stopped build cannot downgrade state.
  if (record.active === null && record.previous === candidateVersion) {
    return null
  }
  // Older Stop records omit app version; refuse only proven newer hosts or they would be stranded.
  if (!record.activeAppVersion) {
    return null
  }
  return compareAppVersions(record.activeAppVersion, appVersion) > 0 ? 'host-newer' : null
}

export function refuseHivewarddHostIdentity(
  record: HivewarddActivationRecord
): HivewarddHostVersionRefusal | null {
  if (
    (record.activeProduct && record.activeProduct !== 'HiveWard') ||
    (!record.activeProduct && record.previousProduct && record.previousProduct !== 'HiveWard')
  ) {
    return 'host-other-product'
  }
  if (!record.activeProduct && (record.active || record.previous)) {
    return 'host-identity-unverified'
  }
  return null
}
