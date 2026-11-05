import type { PairingOffer } from '../../shared/pairing'
import type { HivewarddTunnelIdentity } from '../managed-server/lifecycle/hivewardd-managed-tunnel-identity'
import type { ServeReadiness } from '../server/serve-readiness'
import type { HivewarddHostTransport } from '../ssh/hivewardd-host-transport'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import type { WslDistroHolder } from './wsl-distro-holder'
import type { WslHivewarddConnectionStatus } from './wsl-hivewardd-connection-status'
import type {
  WslHivewarddDeferredUpdate,
  WslHivewarddDeployOptions,
  WslHivewarddLaunch
} from './wsl-hivewardd-deploy'
import type { WslHivewarddHostTarget } from './wsl-hivewardd-host-target'
import type { WslHivewarddPairingRecovery } from './wsl-hivewardd-pairing-identity'
import type { WslHivewarddStdioBridgeOptions } from './wsl-hivewardd-stdio-bridge'

/** One open bridge to a distro's hivewardd, as the connection manager publishes it. */
export type WslHivewarddConnection = {
  distro: string
  environmentId: string
  /** The loopback port on this machine the pairing offer points at. */
  localPort: number
  /** hivewardd's port inside the distro. */
  remotePort: number
  fullVersion: string
  /** hivewardd's pid inside the distro, from its pid file; null when unreadable. */
  pid: number | null
  /** hivewardd's pairing code, with its endpoint rewritten to `ws://127.0.0.1:<localPort>`. */
  pairingOffer: string
  /** An app update the incumbent `fullVersion` is waiting to take (live terminals). */
  deferredUpdate: WslHivewarddDeferredUpdate | null
  close(): Promise<void>
}

export type WslHivewarddConnectionDependencies = {
  holder?: WslDistroHolder
  getPairingOffer?: (environmentId: string) => PairingOffer | null
  /** The bridge port the host's record saved: rebinding it keeps the pairing across app restarts. */
  recordedLocalPort?: (environmentId: string) => number | null
  deployAndLaunch?: (distro: string, options: WslHivewarddDeployOptions) => Promise<WslHivewarddLaunch>
  createTransport?: (target: WslHivewarddHostTarget) => HivewarddHostTransport
  listen?: (
    transport: HivewarddHostTransport,
    options: WslHivewarddStdioBridgeOptions
  ) => Promise<StartedPortForward>
  verifyIdentity?: (pairingOffer: string, readiness: ServeReadiness) => Promise<HivewarddTunnelIdentity>
  /** Re-pairs a refused enrolled token; without it a refusal fails the connect. */
  pairingRecovery?: Omit<WslHivewarddPairingRecovery, 'environmentId'>
  /** A connection (re)opened, its offer changed, or its status moved; null once it closed. */
  onChange?: (
    distro: string,
    connection: WslHivewarddConnection | null,
    status: WslHivewarddConnectionStatus
  ) => void
}
