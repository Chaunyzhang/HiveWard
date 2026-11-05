import { HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/hivewardd-managed-launch-env'

type HivewarddWsPortOptions = {
  wsPort?: number
  preferPinnedWsPort?: boolean
  requirePinnedWsPort?: boolean
}

/** Honor explicit ports; managed launches permit fallback because WSL distros share loopback. */
export function hivewarddWsPortOptions(
  port: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): HivewarddWsPortOptions {
  if (port === undefined) {
    return {}
  }
  const managed = Boolean(env[HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV])
  return {
    wsPort: port,
    preferPinnedWsPort: true,
    ...(managed ? {} : { requirePinnedWsPort: true })
  }
}
