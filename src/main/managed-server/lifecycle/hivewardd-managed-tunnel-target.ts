import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import {
  readManagedHivewarddPublishedPort,
  resolveManagedHivewarddTunnelPort,
  type HivewarddTunnelPortInput
} from './hivewardd-managed-bound-port'
import {
  hivewarddIdentityRefusal,
  verifyManagedHivewarddTunnelIdentity,
  type HivewarddTunnelIdentity
} from './hivewardd-managed-tunnel-identity'
import { managedHivewarddSlot } from './hivewardd-managed-runtime-context'
import { wakeStoppedManagedHivewardd } from './hivewardd-managed-wake'
import { resolveHivewarddRemoteContext } from '../install/hivewardd-remote-context'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { PortForwardEntry } from '../../../shared/ssh-types'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'

export type HivewarddManagedTunnelTargeting = {
  resolveRemotePort: (input: HivewarddTunnelPortInput) => Promise<number>
  verifyIdentity: (environment: KnownRuntimeEnvironment) => Promise<HivewarddTunnelIdentity>
  /** Wake only proven-stopped slots before rereading ports after foreign answers. */
  wakeStoppedServer?: (input: HivewarddTunnelPortInput) => Promise<void>
  readPublishedPort?: (input: HivewarddTunnelPortInput) => Promise<number | null>
}

export const MANAGED_HIVEWARDD_TUNNEL_TARGETING: HivewarddManagedTunnelTargeting = {
  resolveRemotePort: resolveManagedHivewarddTunnelPort,
  verifyIdentity: verifyManagedHivewarddTunnelIdentity,
  wakeStoppedServer: wakeStoppedManagedHivewarddForTunnel,
  readPublishedPort: readManagedHivewarddPublishedPort
}

// Stopped slots may have lost their port; waking publishes a new free port for the reread.
async function wakeStoppedManagedHivewarddForTunnel(input: HivewarddTunnelPortInput): Promise<void> {
  const access = getRuntimeSshAccess(input.environment)
  if (!access) {
    return
  }
  try {
    const context = await resolveHivewarddRemoteContext(input.target, input.connection)
    await wakeStoppedManagedHivewardd(managedHivewarddSlot(context, access.remotePort))
  } catch (error) {
    // Failed wake does not settle identity; reread and validate the resulting forward.
    console.warn(
      '[ssh] Could not start the managed HiveWard server behind a foreign answer:',
      error
    )
  }
}

/** Tests may trust persisted ports without an identity round trip. */
export const PERSISTED_PORT_TARGETING: HivewarddManagedTunnelTargeting = {
  resolveRemotePort: async ({ environment }) => getRuntimeSshAccess(environment)?.remotePort ?? 0,
  verifyIdentity: async () => ({ verdict: 'verified' })
}

type VerifiedHivewarddForwardArgs = {
  targetId: string
  connection: SshConnection
  forwards: SshPortForwardManager
  localPort: number
  label: string
  remotePort: number
  /** Without a reread, foreign answers fail immediately. */
  rereadRemotePort?: () => Promise<number>
  /** Omit when the caller validates identity itself. */
  verify?: (localPort: number) => Promise<HivewarddTunnelIdentity>
  stillCurrent: () => boolean
}

export type HivewarddTunnelStartChecks = Pick<
  VerifiedHivewarddForwardArgs,
  'rereadRemotePort' | 'verify'
> & {
  /** Persisted preferred port when the server bound elsewhere. */
  preferredPort?: number
}

export async function environmentForwardChecks(
  targeting: HivewarddManagedTunnelTargeting,
  input: HivewarddTunnelPortInput
): Promise<Required<Pick<VerifiedHivewarddForwardArgs, 'remotePort' | 'rereadRemotePort' | 'verify'>>> {
  return {
    remotePort: await targeting.resolveRemotePort(input),
    rereadRemotePort: async () => {
      await targeting.wakeStoppedServer?.(input)
      return targeting.resolveRemotePort(input)
    },
    verify: () => targeting.verifyIdentity(input.environment)
  }
}

/** Remove superseded forwards; retry foreign ports once. Pinned-server token refusals fail immediately. */
export async function forwardToVerifiedHivewardd(
  args: VerifiedHivewarddForwardArgs
): Promise<PortForwardEntry | null> {
  let remotePort = args.remotePort
  for (let attempt = 0; ; attempt++) {
    const forward = await addCurrentForward(args, remotePort)
    if (!forward) {
      return null
    }
    const identity = args.verify
      ? await args.verify(forward.localPort)
      : ({ verdict: 'verified' } as const)
    if (!args.stillCurrent()) {
      await args.forwards.removeForwardAndWait(forward.id)
      return null
    }
    if (identity.verdict === 'verified' || identity.verdict === 'unreachable') {
      if (identity.verdict === 'unreachable') {
        // Unreachable servers may be down or starting; this is not proof of a foreign server.
        console.warn(
          `[ssh] Managed HiveWard server did not answer through its tunnel: ${identity.detail}`
        )
      }
      return forward
    }
    await args.forwards.removeForwardAndWait(forward.id)
    // Token refusal from our pinned server is not a moved port; waking cannot repair pairing.
    if (identity.verdict === 'unpaired') {
      throw hivewarddIdentityRefusal(remotePort, identity)
    }
    const reread =
      attempt === 0 && args.rereadRemotePort ? await args.rereadRemotePort() : remotePort
    if (reread === remotePort || !args.stillCurrent()) {
      throw hivewarddIdentityRefusal(remotePort, identity)
    }
    remotePort = reread
  }
}

async function addCurrentForward(
  args: VerifiedHivewarddForwardArgs,
  remotePort: number
): Promise<PortForwardEntry | null> {
  const forward = await args.forwards.addForward(
    args.targetId,
    args.connection,
    args.localPort,
    '127.0.0.1',
    remotePort,
    args.label
  )
  if (args.localPort !== 0 && forward.localPort !== args.localPort) {
    await args.forwards.removeForwardAndWait(forward.id)
    throw new Error('Managed HiveWard tunnel bound an unexpected local port.')
  }
  if (!args.stillCurrent()) {
    await args.forwards.removeForwardAndWait(forward.id)
    return null
  }
  return forward
}
