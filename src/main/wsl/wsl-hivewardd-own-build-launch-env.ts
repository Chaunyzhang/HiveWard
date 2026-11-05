import { hostMallocTunablesLaunchEnv } from '../memory/host-malloc-tunables'
import type { HivewarddHostTransport } from '../ssh/hivewardd-host-transport'

/** An older slot would leak GLIBC_TUNABLES to user shells, so only this build's own slot gets it. */
export function withOwnBuildLaunchEnv<T extends HivewarddHostTransport>(
  conn: T,
  ownBuildVersion: () => string | null
): T {
  const hivewarddLaunchEnv: HivewarddHostTransport['hivewarddLaunchEnv'] = async (launch) => [
    ...((await conn.hivewarddLaunchEnv?.(launch)) ?? []),
    ...(launch.fullVersion === ownBuildVersion() ? hostMallocTunablesLaunchEnv() : [])
  ]
  // Delegate rather than spread so prototype methods survive; #private fields would still need explicit forwarding.
  return Object.create(conn, { hivewarddLaunchEnv: { value: hivewarddLaunchEnv } })
}
