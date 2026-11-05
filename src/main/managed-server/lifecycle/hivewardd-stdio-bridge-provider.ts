// Lost channels drop their sockets but keep the listener; tunnel reconnect logic owns recovery.
import { HivewarddStdioBridgeUnavailableError } from '../../hivewardd/hivewardd-host-unavailable'
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'
import {
  checkHivewarddStdioBridge,
  openHivewarddStdioBridgeChannel,
  resolveHivewarddStdioBridge,
  type HivewarddStdioBridge
} from '../../ssh/hivewardd-stdio-bridge'
import { listenHivewarddStdioBridge } from './hivewardd-stdio-bridge-listener'
import { sshHivewarddHostTransport } from '../../ssh/hivewardd-ssh-host-transport'
import type { RemoteCommandChannel } from '../install/remote-install-transport'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from '../../ssh/port-forwarding/ssh-port-forward-provider'

export type HivewarddStdioBridgeDependencies = {
  resolveBridge: (conn: HivewarddHostTransport, port: number) => Promise<HivewarddStdioBridge>
  checkBridge: (conn: HivewarddHostTransport, bridge: HivewarddStdioBridge) => Promise<unknown>
  openChannel: (conn: HivewarddHostTransport, bridge: HivewarddStdioBridge) => Promise<RemoteCommandChannel>
}

export const HIVEWARDD_STDIO_BRIDGE_DEPENDENCIES: HivewarddStdioBridgeDependencies = {
  resolveBridge: resolveHivewarddStdioBridge,
  checkBridge: checkHivewarddStdioBridge,
  openChannel: openHivewarddStdioBridgeChannel
}

export class HivewarddStdioBridgePortForwardProvider implements SshPortForwardProvider {
  constructor(
    private readonly dependencies: HivewarddStdioBridgeDependencies = HIVEWARDD_STDIO_BRIDGE_DEPENDENCIES
  ) {}

  canHandle(conn: SshConnection): boolean {
    return conn.getClient() !== null || conn.usesSystemSshTransport()
  }

  start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward> {
    return startHivewarddStdioBridge(sshHivewarddHostTransport(conn), options, this.dependencies)
  }
}

export async function startHivewarddStdioBridge(
  host: HivewarddHostTransport,
  options: PortForwardStartOptions,
  deps: HivewarddStdioBridgeDependencies
): Promise<StartedPortForward> {
  let bridge: Promise<HivewarddStdioBridge> | null = null
  // Retry failed bridge resolution on the next socket.
  const resolveBridge = (): Promise<HivewarddStdioBridge> => {
    bridge ??= deps.resolveBridge(host, options.remotePort).catch((error: unknown) => {
      bridge = null
      throw error
    })
    return bridge
  }
  try {
    await deps.checkBridge(host, await resolveBridge())
  } catch (error) {
    if (error instanceof HivewarddStdioBridgeUnavailableError) {
      throw error
    }
    // Lost contact does not prove bridge absence; let new sockets resolve it again.
    console.warn('[ssh] HiveWard stdio bridge check was unverifiable:', error)
  }
  return listenHivewarddStdioBridge(options, async () => {
    const resolved = await resolveBridge()
    return { channel: await deps.openChannel(host, resolved), mode: resolved.mode }
  })
}
