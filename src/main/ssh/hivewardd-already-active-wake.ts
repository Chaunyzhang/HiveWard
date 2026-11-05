import { wakeStoppedManagedHivewardd } from '../managed-server/lifecycle/hivewardd-managed-wake'
import type { HivewarddSlotOptions } from './hivewardd-recovery-slot'

/** Already-active deploys launch nothing; wake that slot only on proven exit, including after reboot. Return whether it was started. */
export async function wakeAlreadyActiveHivewardd(options: HivewarddSlotOptions): Promise<boolean> {
  const wake = await wakeStoppedManagedHivewardd(options)
  if (wake.outcome === 'recovery-refused') {
    throw new Error(wake.reason)
  }
  return wake.outcome === 'started'
}
