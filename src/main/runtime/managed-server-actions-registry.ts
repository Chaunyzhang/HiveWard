/** Desktop main publishes managed-server actions for runtime RPC; headless hosts without a registry advertise none. */
import type {
  HivewarddManagedPastLiveTerminals,
  HivewarddManagedCancelStopResult,
  HivewarddManagedDeployResult,
  HivewarddManagedForgetResult,
  HivewarddManagedRecoveryResult,
  HivewarddManagedRollbackResult,
  HivewarddManagedRuntimeStatus,
  HivewarddManagedStopResult
} from '../../shared/hivewardd-managed-runtime'

export type ManagedServerActions = {
  status: (selector: string) => Promise<HivewarddManagedRuntimeStatus>
  update: (
    selector: string,
    force: boolean,
    pastLiveTerminals?: HivewarddManagedPastLiveTerminals
  ) => Promise<HivewarddManagedDeployResult>
  rollback: (selector: string) => Promise<HivewarddManagedRollbackResult>
  /** `acceptChangedState` restores the snapshot over state a rejected build changed. */
  recover: (selector: string, acceptChangedState?: boolean) => Promise<HivewarddManagedRecoveryResult>
  stop: (selector: string) => Promise<HivewarddManagedStopResult>
  cancelStop: (selector: string) => Promise<HivewarddManagedCancelStopResult>
  forget: (selector: string) => Promise<HivewarddManagedForgetResult>
}

let registered: ManagedServerActions | null = null

export function registerManagedServerActions(actions: ManagedServerActions | null): void {
  registered = actions
}

export function getManagedServerActions(): ManagedServerActions | null {
  return registered
}
