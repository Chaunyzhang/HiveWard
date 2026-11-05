// Open forwards prove no identity; require an authenticated status call from the pinned server.
import { parsePairingCode } from '../../../shared/pairing'
import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../../../shared/paired-runtime-connection'
import { HIVEWARDD_MANAGED_REMOTE_PORT } from '../../../shared/hivewardd-managed-runtime'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime/remote-runtime-client-error-classification'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { verifyRuntimePairingIdentity } from '../../runtime/runtime-environment-identity-verification'
import type { ServeReadiness } from '../../server/serve-readiness'
import { hivewarddBoundPort } from './hivewardd-managed-bound-port'
import { tunneledHivewarddPairingCode } from '../../ssh/hivewardd-tunneled-pairing'

/** Unreachable proves no identity; unpaired is a refusal sealed by the pinned server key. */
export type HivewarddTunnelIdentity =
  | { verdict: 'verified' }
  | { verdict: 'foreign' | 'unreachable' | 'unpaired'; detail: string }

export const HIVEWARDD_IDENTITY_MISMATCH_CODE = 'hivewardd_identity_mismatch'

export class HivewarddManagedIdentityError extends Error {
  readonly code = HIVEWARDD_IDENTITY_MISMATCH_CODE
  constructor(remotePort: number, detail: string) {
    super(
      `${HIVEWARDD_IDENTITY_MISMATCH_CODE}: the server on remote port ${remotePort} is not this ` +
        `host’s HiveWard server (another HiveWard may be using that port): ${detail}`
    )
    this.name = 'HivewarddManagedIdentityError'
  }
}

export const HIVEWARDD_PAIRING_REJECTED_CODE = 'hivewardd_pairing_rejected'

export class HivewarddManagedPairingRejectedError extends Error {
  readonly code = HIVEWARDD_PAIRING_REJECTED_CODE
  constructor(detail: string) {
    super(
      `${HIVEWARDD_PAIRING_REJECTED_CODE}: this host’s HiveWard server no longer accepts ` +
        `this desktop's pairing (its saved devices were reset, or this desktop was removed ` +
        `there), so reconnecting alone won't restore access: ${detail}`
    )
    this.name = 'HivewarddManagedPairingRejectedError'
  }
}

export function hivewarddIdentityRefusal(
  remotePort: number,
  identity: Exclude<HivewarddTunnelIdentity, { verdict: 'verified' }>
): Error {
  return identity.verdict === 'unpaired'
    ? new HivewarddManagedPairingRejectedError(identity.detail)
    : new HivewarddManagedIdentityError(remotePort, identity.detail)
}

// Key rejection closes the socket instead of returning a status reply.
const FOREIGN_CLOSE_CODES = new Set([4001, 4003])

export function classifyHivewarddTunnelIdentityFailure(error: unknown): HivewarddTunnelIdentity {
  const detail = error instanceof Error ? error.message : String(error)
  // Only sealed access-grant refusals prove the pinned server answered.
  if (
    error instanceof RemoteRuntimeClientError &&
    error.code === 'unauthorized' &&
    error.pairingStage === 'access-grant'
  ) {
    return { verdict: 'unpaired', detail }
  }
  if (error instanceof RemoteRuntimeClientError && FOREIGN_CLOSE_CODES.has(error.closeCode ?? 0)) {
    return { verdict: 'foreign', detail }
  }
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
    ? { verdict: 'unreachable', detail }
    : { verdict: 'foreign', detail }
}

export async function verifyHivewarddPairingIdentity(
  connection: PairedRuntimeConnection,
  expected: Pick<KnownRuntimeEnvironment, 'runtimeId' | 'pairedDeviceId'>
): Promise<HivewarddTunnelIdentity> {
  try {
    await verifyRuntimePairingIdentity(connection, expected)
    return { verdict: 'verified' }
  } catch (error) {
    return classifyHivewarddTunnelIdentityFailure(error)
  }
}

export function verifyManagedHivewarddTunnelIdentity(
  environment: KnownRuntimeEnvironment
): Promise<HivewarddTunnelIdentity> {
  if (!environment.hivewarddDeployment) {
    return Promise.resolve({ verdict: 'verified' })
  }
  // Runtime/device IDs can change or become stale; pinned-key handshake and token acceptance prove identity.
  return verifyHivewarddPairingIdentity(getPreferredPairedRuntimeConnection(environment), {
    runtimeId: null
  })
}

/** Fresh deploys have no saved pairing; reread readiness after foreign answers to follow port changes. */
export function deployedHivewarddTunnelChecks(
  initial: ServeReadiness,
  rereadReadiness: () => Promise<ServeReadiness>
) {
  let readiness = initial
  return {
    readiness: () => readiness,
    remotePort: hivewarddBoundPort(initial) ?? HIVEWARDD_MANAGED_REMOTE_PORT,
    rereadRemotePort: async () => {
      readiness = await rereadReadiness()
      return hivewarddBoundPort(readiness) ?? HIVEWARDD_MANAGED_REMOTE_PORT
    },
    verify: async (localPort: number): Promise<HivewarddTunnelIdentity> => {
      const pairing = parsePairingCode(tunneledHivewarddPairingCode(readiness, localPort))
      return pairing
        ? verifyHivewarddPairingIdentity(pairedRuntimeConnectionFromOffer(pairing), {
            runtimeId: readiness.runtimeId || null
          })
        : {
            verdict: 'foreign',
            detail: 'This host’s HiveWard server published an invalid pairing.'
          }
    }
  }
}
