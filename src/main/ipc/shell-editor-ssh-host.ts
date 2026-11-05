import { getAppEnvironment } from '../../shared/app-environment'
import { parseExecutionHostId, toSshExecutionHostId } from '../../shared/execution-host'
import { getManagedHivewarddFenceEnvironmentId } from '../../shared/managed-hivewardd-ssh-owner'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  getHivewarddSshDeployment,
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import { fingerprintRuntimeSshTarget } from '../ssh/runtime-ssh-target-fingerprint'

export type ListRuntimeEnvironments = () => readonly Pick<
  KnownRuntimeEnvironment,
  'id' | 'hivewarddDeployment' | 'sshAccess'
>[]

export const listAppRuntimeEnvironments: ListRuntimeEnvironments = () =>
  listEnvironments(getAppEnvironment().getPath('userData'))

/** Whether `target` is the SSH host that owns the path: that host, or the one its server runs on. */
export function isEditorSshHostForOwner(
  target: SshTarget,
  ownerHostId: unknown,
  listRuntimeEnvironments: ListRuntimeEnvironments
): boolean {
  if (ownerHostId === toSshExecutionHostId(target.id)) {
    return true
  }
  const owner = typeof ownerHostId === 'string' ? parseExecutionHostId(ownerHostId) : null
  if (owner?.kind !== 'runtime') {
    return false
  }
  let environments: ReturnType<ListRuntimeEnvironments>
  try {
    environments = listRuntimeEnvironments()
  } catch {
    return false
  }
  // Re-derive ownership in main so renderer claims cannot redirect editing to another host.
  const environment = environments.find((entry) => entry.id === owner.environmentId)
  const link = environment ? getRuntimeSshAccess(environment) : undefined
  if (!environment || link?.sshTargetId !== target.id) {
    return false
  }
  // A stale link can name a different host that reused the registration ID.
  if (target.generation !== link.sshTargetGeneration) {
    return false
  }
  if (getHivewarddSshDeployment(environment)) {
    return getManagedHivewarddFenceEnvironmentId(target) === environment.id
  }
  // Edits retain generation, so also pin the settings used to verify SSH access.
  const access = environment.sshAccess
  return (
    !!access?.targetFingerprint && fingerprintRuntimeSshTarget(target) === access.targetFingerprint
  )
}
