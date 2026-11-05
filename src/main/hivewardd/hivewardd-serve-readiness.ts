import type { ServeReadiness } from '../server/serve-readiness'
import type { HiveWardRuntimeRpcServer } from '../runtime/runtime-rpc'
import { buildServePairingReadiness } from '../server/serve-pairing-readiness'
import type { HivewarddHealth } from './hivewardd-health'
import type { HivewarddOptions } from './hivewardd-start-contract'

export async function buildHivewarddServeReadiness(input: {
  options: HivewarddOptions
  runtimeId: string
  rpc: Pick<HiveWardRuntimeRpcServer, 'getWebSocketEndpoint' | 'createPairingOffer'>
  collectHealth: () => Promise<HivewarddHealth>
}): Promise<ServeReadiness> {
  return {
    runtimeId: input.runtimeId,
    ...(await buildServePairingReadiness(input.options, input.rpc)),
    // WSL CLI reconciliation runs only in desktop launch, so no repair is pending here.
    managedWslCliReconciliation: 'settled',
    // Deployers inspect readiness health to reject hosts whose terminal daemon is unavailable.
    health: await input.collectHealth()
  }
}
