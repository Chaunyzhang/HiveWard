import type { SshTarget } from '../../shared/ssh-types'
import type { WslHivewarddHostTarget } from '../wsl/wsl-hivewardd-host-target'
import type { RemoteInstallTransport } from '../managed-server/install/remote-install-transport'
import type { HivewarddLaunchDetach } from '../managed-server/install/hivewardd-remote-launch'

/** Only id/label have the same meaning across host kinds. */
export type HivewarddHostTarget = SshTarget | WslHivewarddHostTarget

export function isWslHivewarddHostTarget(target: HivewarddHostTarget): target is WslHivewarddHostTarget {
  return 'kind' in target && target.kind === 'wsl'
}

export type HivewarddHostTransport = RemoteInstallTransport & {
  getTarget(): HivewarddHostTarget
  /** Absent on SSH, which detaches with nohup. */
  readonly hivewarddLaunchDetach?: HivewarddLaunchDetach
  /** Pass client-only host facts at launch; SSH adds none. */
  readonly hivewarddLaunchEnv?: (
    launch: HivewarddLaunchEnvRequest
  ) => Promise<readonly HivewarddLaunchEnvEntry[]>
}

/** The slot being launched; entries only its own build understands must check the version. */
export type HivewarddLaunchEnvRequest = { readonly fullVersion: string }

/** `keep-existing` applies the value only when the launching shell has none, so a user's own setting wins. */
export type HivewarddLaunchEnvEntry = readonly [name: string, value: string, mode?: 'keep-existing']
