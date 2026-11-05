/** Pair with an already-running foreign build before considering update; an unpaired first deploy cannot census its terminals. */
import type { ServeReadiness } from '../server/serve-readiness'
import type { HivewarddManagedDeferral } from '../../shared/hivewardd-managed-runtime'
import { hivewarddActivationFenceRefusal } from '../managed-server/activation/hivewardd-activation-fence-hold'
import { HivewarddActiveReadinessError, probeActiveHivewarddReadiness } from './hivewardd-active-readiness'
import type { HivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'
import { readHivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record-store'
import { wakeStoppedManagedHivewardd } from '../managed-server/lifecycle/hivewardd-managed-wake'
import { resolveHivewarddSlotIdentity, type HivewarddSlotOptions } from './hivewardd-recovery-slot'

export type HivewarddRunningAdoption = {
  version: string
  readiness: ServeReadiness
  /** Reads the adopted slot's readiness again, e.g. after it rebinds its port. */
  reprobe: () => Promise<ServeReadiness>
}

/** No foreign activation returns null for normal deploy. A held peer fence defers: deploying without pairing would only fail census (#28833). */
export async function adoptRunningHivewarddVersion(
  slot: HivewarddSlotOptions,
  record: HivewarddActivationRecord,
  localVersion: string,
  retryClearedFence = true
): Promise<HivewarddRunningAdoption | HivewarddManagedDeferral | null> {
  if (!record.active || record.active === localVersion) {
    return null
  }
  // Wake only on proven server exit; idle stops leave daemon terminals alive.
  const wake = await wakeStoppedManagedHivewardd(slot)
  switch (wake.outcome) {
    // Another desktop stopped it meanwhile; the deploy's own gates decide.
    case 'not-activated':
      return null
    case 'fenced': {
      // E.g. another desktop starting it after a reboot; a later connect pairs with it.
      const { cleared, ...refusal } = await hivewarddActivationFenceRefusal(slot, 'server start')
      if (cleared && retryClearedFence) {
        return adoptRunningHivewarddVersion(slot, record, localVersion, false)
      }
      return { outcome: 'deferred', candidateVersion: localVersion, ...refusal, forceable: false }
    }
    case 'unverifiable':
      throw new HivewarddActiveReadinessError(
        'unverifiable',
        `HiveWard ${record.active} runs this host's server, but its process state is unverifiable, ` +
          'so it was left as it is. Try connecting again.'
      )
    case 'recovery-refused':
      throw new Error(wake.reason)
    case 'serving':
    case 'started':
      break
  }
  // Re-read activation because wake follows peer changes to the current record.
  const active = (await readHivewarddActivationRecord(slot)).active
  if (!active || active === localVersion) {
    return null
  }
  const identity = await resolveHivewarddSlotIdentity(slot, active)
  const reprobe = () =>
    probeActiveHivewarddReadiness(
      { ...slot, remoteInstallDir: identity.remoteDir },
      { buildHash: identity.buildHash, fullVersion: identity.version }
    )
  return { version: active, readiness: await reprobe(), reprobe }
}
