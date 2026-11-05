import type { HivewarddManagedRefusal } from './hivewardd-managed-runtime'
import type { HivewarddDaemonRetirementVerdict } from './hivewardd-stop-request'

export type HivewarddDecommissionResult =
  | {
      outcome: 'decommissioned'
      version: string
      /** The daemon's fate: `retired`, or kept with its terminals (`live`/`unverifiable`). */
      retirement: HivewarddDaemonRetirementVerdict
    }
  | HivewarddManagedRefusal
