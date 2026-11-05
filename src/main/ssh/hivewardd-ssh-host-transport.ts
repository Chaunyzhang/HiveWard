import type { HivewarddHostTransport } from './hivewardd-host-transport'
import type { SshConnection } from './connection/ssh-connection'

/** Return the connection object itself: tunnel ownership, dedupe and caches depend on its identity. */
export function sshHivewarddHostTransport(connection: SshConnection): HivewarddHostTransport {
  return connection
}
