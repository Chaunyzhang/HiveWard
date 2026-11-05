// Only refusals sealed by the pinned key may trigger repair; foreign servers fail identity checks.
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { pairingRevisionOf, type ManagedHivewarddPairingGate } from './hivewardd-managed-pairing-repair'
import { HivewarddManagedPairingRejectedError } from './hivewardd-managed-tunnel-identity'

export type ManagedHivewarddPairingRecovery = {
  resolve: (environmentId: string) => KnownRuntimeEnvironment
  repairs: ManagedHivewarddPairingGate
  ensure: (environment: KnownRuntimeEnvironment) => Promise<void>
}

/** Check cached refusal before building; permit one repair and rebuild on a refused pairing. */
export async function buildWithPairingRepair(
  recovery: ManagedHivewarddPairingRecovery,
  environmentId: string,
  build: (environment: KnownRuntimeEnvironment) => Promise<void>
): Promise<'built' | 'repaired'> {
  const refused = recovery.resolve(environmentId)
  const epoch = recovery.repairs.resetEpoch(environmentId)
  const standing = recovery.repairs.standingFailure(environmentId, pairingRevisionOf(refused))
  if (standing) {
    throw standing
  }
  try {
    await build(refused)
    return 'built'
  } catch (error) {
    if (!(error instanceof HivewarddManagedPairingRejectedError)) {
      throw error
    }
    console.warn('[managed-hivewardd] The HiveWard server refused this desktop; pairing again:', error)
  }
  // Revision matching joins already-completed repairs instead of repeating host work.
  const repaired = await recovery.repairs.repair(environmentId, pairingRevisionOf(refused))
  try {
    await recovery.ensure(repaired)
  } catch (error) {
    throw error instanceof HivewarddManagedPairingRejectedError
      ? recovery.repairs.recordRefusedAfterRepair(environmentId, pairingRevisionOf(repaired), epoch)
      : error
  }
  return 'repaired'
}
