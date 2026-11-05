/**
 * A same-version WSL connect takes one activation fence instead of two: the deploy confirms the
 * slot is installed and skips its own fence, then the wake's fence re-reads the record and starts
 * the slot if it stopped. A fence the snapshot saw held, another version active by then, or a busy
 * fence all run the full deploy and wake, as before.
 */
import type { HivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'
import { wakeExpectedHivewarddUnderOneFence } from '../managed-server/lifecycle/hivewardd-managed-wake'
import type { HivewarddDeployOptions, HivewarddDeployResult } from '../ssh/hivewardd-remote-deploy'
import type { HivewarddSlotOptions } from '../ssh/hivewardd-recovery-slot'

type DeployExtra = Pick<HivewarddDeployOptions, 'preRead' | 'sameVersionFencedByCaller'>

export async function deployWslHivewarddWithOneFence(
  slot: HivewarddSlotOptions,
  deploy: (extra: DeployExtra) => Promise<HivewarddDeployResult>,
  hinted: { preRead?: { record: HivewarddActivationRecord; fenceOpen: boolean } }
): Promise<{ deployed: HivewarddDeployResult; woken: boolean }> {
  if (!hinted.preRead?.fenceOpen) {
    return { deployed: await deploy(hinted), woken: false }
  }
  const first = await deploy({ ...hinted, sameVersionFencedByCaller: true })
  if (first.outcome !== 'already-active') {
    return { deployed: first, woken: false }
  }
  const wake = await wakeExpectedHivewarddUnderOneFence(slot, first.fullVersion)
  if (wake.outcome === 'replan' || wake.outcome === 'fenced') {
    // The host moved since the snapshot, so this deploy takes no hints.
    return { deployed: await deploy({}), woken: false }
  }
  if (wake.outcome === 'recovery-refused') {
    throw new Error(wake.reason)
  }
  return { deployed: first, woken: true }
}
