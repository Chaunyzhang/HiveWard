import { HIVEWARDD_IDLE_TIMEOUT_ENV } from './hivewardd-idle-exit'
import { HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV } from './hivewardd-managed-launch-env'

/** WSL-host launch marker; SSH guests and WSLg retain their original PATH. */
export const HIVEWARDD_WSL_HOST_ENV = 'HIVEWARD_WSL_HIVEWARDD_HOST'

/** Desktop-provided registry ID; guests cannot read it themselves. */
export const HIVEWARDD_WSL_DISTRO_GUID_ENV = 'HIVEWARD_WSL_DISTRO_GUID'

/**
 * What a client puts in a server's launch env. A user's own `hivewardd` started from one of the
 * server's shells is not that server, so every pane scrubs these.
 */
export const HIVEWARDD_SERVER_LAUNCH_ENV_KEYS = [
  // Not client-managed.
  HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV,
  // Keeps the default idle window.
  HIVEWARDD_IDLE_TIMEOUT_ENV,
  // Not a WSL host: no migration capabilities, no /mnt/c refusal, no account-push wait.
  HIVEWARDD_WSL_HOST_ENV,
  HIVEWARDD_WSL_DISTRO_GUID_ENV
] as const
