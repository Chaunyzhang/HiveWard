export const HIVEWARDD_PAIRING_REPAIR_FAILED_CODE = 'hivewardd_pairing_repair_failed'

export class HivewarddManagedPairingRepairFailedError extends Error {
  readonly code = HIVEWARDD_PAIRING_REPAIR_FAILED_CODE
  constructor(reason: string) {
    super(
      `${HIVEWARDD_PAIRING_REPAIR_FAILED_CODE}: the HiveWard server on this host no longer accepts this ` +
        `computer, and HiveWard couldn't pair with it again over SSH: ${reason}. Nothing on the host ` +
        `was stopped; its terminals can't be verified until HiveWard pairs again. Connect again to retry.`
    )
    this.name = 'HivewarddManagedPairingRepairFailedError'
  }
}
