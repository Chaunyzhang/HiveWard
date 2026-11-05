import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { removeManagedHivewarddEnvironment } from '../../shared/runtime-environment-managed-hivewardd-store'
import { listEnvironments, removeEnvironment } from '../../shared/runtime-environment-store'
import { getHivewarddSshDeployment } from '../../shared/runtime-environments'

/** Remove destroyed VM servers so managed tunnels stop reconnecting. */
export async function releaseEphemeralVmRuntimeEnvironments(
  userDataPath: string,
  runtime: Pick<EphemeralVmRuntimeRecord, 'runtimeEnvironmentId' | 'sshTargetId'>,
  // Same retirement as a Settings removal, so the host's session partition and transport go too.
  retireRemovedEnvironment: (environmentId: string) => void
): Promise<void> {
  // Relay-era conversions may have recorded only the SSH target, not the server ID.
  const environments = listEnvironments(userDataPath).filter(
    (entry) =>
      entry.id === runtime.runtimeEnvironmentId ||
      (runtime.sshTargetId !== undefined &&
        getHivewarddSshDeployment(entry)?.sshTargetId === runtime.sshTargetId)
  )
  for (const environment of environments) {
    if (!environment.hivewarddDeployment) {
      removeEnvironment(userDataPath, environment.id)
      retireRemovedEnvironment(environment.id)
      continue
    }
    const { closeHivewarddManagedTunnel } =
      await import('../managed-server/lifecycle/hivewardd-managed-tunnel')
    await closeHivewarddManagedTunnel(environment.id).catch(() => undefined)
    removeManagedHivewarddEnvironment(userDataPath, environment.id)
    retireRemovedEnvironment(environment.id)
  }
}
