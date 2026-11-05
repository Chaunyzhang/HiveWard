/** R39: a WSL host's server lives in the Linux login's ~/.hiveward, so another HiveWard on this computer may share it. */
import { z } from 'zod'
import { HIVEWARDD_PEER_DESKTOPS_RUNTIME_CAPABILITY } from '../../shared/hivewardd-runtime-capabilities'
import {
  HIVEWARDD_PEER_DESKTOPS_METHOD,
  HivewarddPeerDesktopsResultSchema
} from '../../shared/hivewardd-peer-desktops-contract'
import { wslHostClientInstanceId } from './wsl-host-client-instance'

export type WslHostPeerDesktops =
  | { kind: 'none' }
  | { kind: 'shared'; names: string[] }
  /** An older server can't say: Remove keeps today's teardown. */
  | { kind: 'unsupported' }

const StatusCapabilitiesSchema = z.looseObject({ capabilities: z.array(z.string()).optional() })

/**
 * Another HiveWard counts only while its control socket is open on the server right now; a closed one
 * isn't protected. Throws when the server can't answer, so the caller refuses the teardown.
 */
export async function readWslHostPeerDesktops(
  call: (method: string, params: unknown) => Promise<unknown>,
  clientInstanceId = wslHostClientInstanceId()
): Promise<WslHostPeerDesktops> {
  const status = StatusCapabilitiesSchema.parse(await call('status.get', undefined))
  if (!status.capabilities?.includes(HIVEWARDD_PEER_DESKTOPS_RUNTIME_CAPABILITY)) {
    return { kind: 'unsupported' }
  }
  const { peers } = HivewarddPeerDesktopsResultSchema.parse(
    await call(HIVEWARDD_PEER_DESKTOPS_METHOD, { clientInstanceId })
  )
  return peers.length > 0
    ? { kind: 'shared', names: peers.map((peer) => peer.name) }
    : { kind: 'none' }
}
