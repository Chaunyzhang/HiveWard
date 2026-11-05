import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import type { ServeReadiness } from '../server/serve-readiness'
import {
  hivewarddIdentityRefusal,
  verifyHivewarddPairingIdentity,
  type HivewarddTunnelIdentity
} from '../managed-server/lifecycle/hivewardd-managed-tunnel-identity'
import { tunneledHivewarddPairingCode } from '../ssh/hivewardd-tunneled-pairing'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import {
  buildWithPairingRepair,
  type ManagedHivewarddPairingRecovery
} from '../managed-server/lifecycle/hivewardd-managed-tunnel-pairing-recovery'
import type { WslHivewarddLaunch } from './wsl-hivewardd-deploy'

/** The managed repair gate a refused enrolled token goes through, for one WSL host. */
export type WslHivewarddPairingRecovery = Omit<ManagedHivewarddPairingRecovery, 'ensure'> & {
  environmentId: string
}

/** Reconnect with enrolled token/pinned host key. Repair refusal once through the gate and verify the replacement; startup offers are for enrollment only. */
export async function resolveWslHivewarddPairing(
  launch: Extract<WslHivewarddLaunch, { outcome: 'ready' }>,
  localPort: number,
  paired: PairingOffer | null,
  verifyIdentity = verifyWslHivewarddIdentity,
  recovery?: WslHivewarddPairingRecovery
): Promise<string> {
  const verified = (offer: PairingOffer | null) =>
    verifyWslHivewarddPairing(launch, localPort, offer, verifyIdentity)
  // First-time pairing has no enrolled token to repair.
  if (!recovery || !paired) {
    return verified(paired)
  }
  let pairingOffer = ''
  await buildWithPairingRepair(
    {
      ...recovery,
      ensure: async (environment) => {
        pairingOffer = await verified(getPreferredPairingOffer(environment))
      }
    },
    recovery.environmentId,
    async () => {
      pairingOffer = await verified(paired)
    }
  )
  return pairingOffer
}

async function verifyWslHivewarddPairing(
  launch: Extract<WslHivewarddLaunch, { outcome: 'ready' }>,
  localPort: number,
  paired: PairingOffer | null,
  verifyIdentity: typeof verifyWslHivewarddIdentity
): Promise<string> {
  const pairingOffer = tunneledHivewarddPairingCode(launch.readiness, localPort, paired)
  const identity = await verifyIdentity(pairingOffer, launch.readiness)
  if (identity.verdict === 'foreign' || identity.verdict === 'unpaired') {
    throw hivewarddIdentityRefusal(launch.port, identity)
  }
  if (identity.verdict === 'unreachable') {
    console.warn(
      `[wsl] HiveWard server in ${launch.distro} did not answer its bridge: ${identity.detail}`
    )
  }
  return pairingOffer
}

/** Whether the server behind a WSL bridge is the hivewardd that published `readiness`. */
export async function verifyWslHivewarddIdentity(
  pairingOffer: string,
  readiness: ServeReadiness
): Promise<HivewarddTunnelIdentity> {
  const offer = parsePairingCode(pairingOffer)
  return offer
    ? verifyHivewarddPairingIdentity(pairedRuntimeConnectionFromOffer(offer), {
        runtimeId: readiness.runtimeId || null
      })
    : {
        verdict: 'foreign',
        detail: 'The HiveWard server in WSL published an invalid pairing offer.'
      }
}
