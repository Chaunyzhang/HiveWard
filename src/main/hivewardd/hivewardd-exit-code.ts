import { HivewarddBindAddressError } from './hivewardd-bind-address'
import { HivewarddBundledRuntimeError } from './hivewardd-bundled-runtime'
import { HivewarddInstanceLockError } from './hivewardd-data-root-privacy'
import { ProfileStateAccessError } from '../persistence/profile-state/profile-state-access'
import { HIVEWARDD_EXIT_CONFIGURATION } from './hivewardd-configuration-exit'
import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from '../../shared/single-instance-exit-code'

export const HIVEWARDD_EXIT_FAILED = 1

export function resolveHivewarddExitCode(error: unknown): number {
  // Supervisors wait for an existing holder instead of abandoning the host.
  if (
    error instanceof HivewarddInstanceLockError &&
    error.code === 'hivewardd_instance_lock_holder_unverifiable'
  ) {
    return SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
  }
  return error instanceof HivewarddInstanceLockError ||
    error instanceof HivewarddBindAddressError ||
    error instanceof HivewarddBundledRuntimeError ||
    error instanceof ProfileStateAccessError
    ? HIVEWARDD_EXIT_CONFIGURATION
    : HIVEWARDD_EXIT_FAILED
}
