// Repair over trusted host access, but accept only offers matching the desktop's pinned server key.
import { parsePairingCode } from '../../../shared/pairing'
import { errorMessage } from '../../../shared/error-message'
import { getManagedHivewarddFenceEnvironmentId } from '../../../shared/managed-hivewardd-ssh-owner'
import { refreshManagedHivewarddPairing } from '../../../shared/runtime-environment-managed-hivewardd-store'
import { assertRuntimeEnvironmentNotReconciling } from '../../../shared/runtime-environment-reconciliation-record'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import {
  getHivewarddSshDeployment,
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { ServeReadiness } from '../../server/serve-readiness'
import type { HivewarddHostTarget, HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'
import { tunneledHivewarddPairingCode } from '../../ssh/hivewardd-tunneled-pairing'
import {
  getSshConnectionManager,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import { readActiveManagedHivewarddReadiness } from './hivewardd-managed-bound-port'
import { HivewarddManagedIdentityError } from './hivewardd-managed-tunnel-identity'
import { HivewarddManagedPairingRepairFailedError } from './hivewardd-managed-pairing-repair-failure'
import { notifyManagedHivewarddPairingRepaired } from './hivewardd-managed-pairing-repaired-listener'

// Cap servers that keep refusing fresh pairing offers to avoid endless repair.
export const MAX_PAIRING_REPAIRS_PER_WINDOW = 3
export const PAIRING_REPAIR_WINDOW_MS = 10 * 60_000
// Briefly cache failures so reconnecting panes do not each reread the host.
export const PAIRING_REPAIR_FAILURE_HOLD_MS = 15_000

type ManagedHivewarddHostAccess = { target: HivewarddHostTarget; connection: HivewarddHostTransport }

export type ManagedHivewarddPairingRepairDeps<
  Access extends ManagedHivewarddHostAccess = ManagedHivewarddHostAccess
> = {
  resolve: (environmentId: string) => KnownRuntimeEnvironment
  connect: (environment: KnownRuntimeEnvironment) => Promise<Access>
  readReadiness: (input: Access) => Promise<ServeReadiness | null>
  /** Override ports for bridges; SSH uses deployment ports by default. */
  ports?: (environment: KnownRuntimeEnvironment) => { localPort: number; remotePort: number } | null
  refresh: (environmentId: string, pairingCode: string) => KnownRuntimeEnvironment
  /** Retire transports using the refused token once per repair. */
  repaired: (environmentId: string) => void | Promise<void>
  now: () => number
}

export function liveManagedHivewarddPairingRepairDeps(
  userDataPath: string
): ManagedHivewarddPairingRepairDeps {
  return {
    resolve: (environmentId) => resolveEnvironment(userDataPath, environmentId),
    connect: connectManagedHivewarddHost,
    readReadiness: readActiveManagedHivewarddReadiness,
    refresh: (environmentId, pairingCode) =>
      refreshManagedHivewarddPairing(userDataPath, environmentId, pairingCode),
    repaired: notifyManagedHivewarddPairingRepaired,
    now: Date.now
  }
}

async function connectManagedHivewarddHost(environment: KnownRuntimeEnvironment) {
  const deployment = getHivewarddSshDeployment(environment)
  const store = getSshTargetRegistryStore()
  const connections = getSshConnectionManager()
  if (!deployment || !store || !connections) {
    throw new Error('SSH is unavailable on this client')
  }
  const target = store.getTarget(deployment.sshTargetId)
  if (
    !target ||
    target.generation !== deployment.sshTargetGeneration ||
    getManagedHivewarddFenceEnvironmentId(target) !== environment.id
  ) {
    throw new Error('the SSH registration for this server was removed or re-created')
  }
  return { target, connection: await connections.connect(target) }
}

/** Refusal revisions prevent repeating repairs already stored by another attempt. */
export function pairingRevisionOf(environment: KnownRuntimeEnvironment): number {
  return environment.pairingRevision ?? environment.createdAt
}

type StandingFailure = { error: Error; revision: number; until: number }

/** Coalesce and cap repairs per environment; refusals of older revisions reuse the stored pairing. */
export class ManagedHivewarddPairingRepairs<
  Access extends ManagedHivewarddHostAccess = ManagedHivewarddHostAccess
> {
  private readonly inFlight = new Map<string, Promise<KnownRuntimeEnvironment>>()
  private readonly attemptedAt = new Map<string, number[]>()
  private readonly standing = new Map<string, StandingFailure>()
  // In-flight repairs must not undo an explicit user reset.
  private readonly resets = new Map<string, number>()

  constructor(private readonly deps: ManagedHivewarddPairingRepairDeps<Access>) {}

  /** Check before building to avoid SSH, forwarding and handshake work for a known refusal. */
  standingFailure(environmentId: string, revision: number): Error | null {
    const failure = this.standing.get(environmentId)
    return failure && failure.revision === revision && this.deps.now() < failure.until
      ? failure.error
      : null
  }

  repair(environmentId: string, refusedRevision: number): Promise<KnownRuntimeEnvironment> {
    const pending = this.inFlight.get(environmentId)
    if (pending) {
      return pending
    }
    const operation = this.run(environmentId, refusedRevision).finally(() => {
      this.inFlight.delete(environmentId)
    })
    this.inFlight.set(environmentId, operation)
    return operation
  }

  /** Charge refusal to the attempted revision; newer untried pairings must remain eligible. */
  recordRefusedAfterRepair(environmentId: string, repairedRevision: number, epoch: number): Error {
    return this.stand(
      environmentId,
      repairedRevision,
      epoch,
      new HivewarddManagedPairingRepairFailedError('the server refused the new pairing too')
    )
  }

  /** Explicit connects clear both cached failure and attempt cap. */
  forgetFailures(environmentId: string): void {
    this.standing.delete(environmentId)
    this.attemptedAt.delete(environmentId)
    this.resets.set(environmentId, this.resetsOf(environmentId) + 1)
  }

  private async run(
    environmentId: string,
    refusedRevision: number
  ): Promise<KnownRuntimeEnvironment> {
    const environment = this.deps.resolve(environmentId)
    if (pairingRevisionOf(environment) !== refusedRevision) {
      return environment
    }
    const epoch = this.resetsOf(environmentId)
    const fail = (error: Error): Error => this.stand(environmentId, refusedRevision, epoch, error)
    const standing = this.standingFailure(environmentId, refusedRevision)
    if (standing) {
      throw standing
    }
    const recent = this.recentAttempts(environmentId)
    if (recent.length >= MAX_PAIRING_REPAIRS_PER_WINDOW) {
      throw fail(capSpentError(recent.length))
    }
    assertRuntimeEnvironmentNotReconciling(environment)
    const deployment = (this.deps.ports ?? getHivewarddSshDeployment)(environment)
    if (!deployment) {
      throw new HivewarddManagedPairingRepairFailedError('this server has no managed deployment')
    }
    // Losing host contact proves nothing about pairing; count only completed reads.
    const readiness = await this.deps.readReadiness(await this.deps.connect(environment))
    // Updates may store new pairings during SSH reads; recheck before synchronous validation/write.
    const current = this.deps.resolve(environmentId)
    if (pairingRevisionOf(current) !== refusedRevision) {
      return current
    }
    if (this.resetsOf(environmentId) === epoch) {
      this.attemptedAt.set(environmentId, [...this.recentAttempts(environmentId), this.deps.now()])
    }
    const pairingCode = publishedPairingCode(readiness, deployment.localPort, fail)
    const offer = parsePairingCode(pairingCode)
    const pinned = getPreferredPairingOffer(environment)
    // Host access alone cannot authorize a different server key.
    if (!offer || offer.publicKeyB64 !== pinned.publicKeyB64) {
      throw fail(
        new HivewarddManagedIdentityError(
          deployment.remotePort,
          "the host's server now publishes a different host key than the one this desktop pinned"
        )
      )
    }
    if (offer.deviceToken === pinned.deviceToken) {
      throw fail(
        new HivewarddManagedPairingRepairFailedError(
          'the server still offers the pairing it refused; restarting it on the host issues a new one'
        )
      )
    }
    let repaired: KnownRuntimeEnvironment
    try {
      repaired = this.deps.refresh(environmentId, pairingCode)
    } catch (error) {
      throw fail(new HivewarddManagedPairingRepairFailedError(errorMessage(error)))
    }
    this.standing.delete(environmentId)
    await this.deps.repaired(environmentId)
    return repaired
  }

  private recentAttempts(environmentId: string): number[] {
    const now = this.deps.now()
    return (this.attemptedAt.get(environmentId) ?? []).filter(
      (at) => now - at < PAIRING_REPAIR_WINDOW_MS
    )
  }

  /** Prevent pre-Connect failures from surviving the user's reset. */
  resetEpoch(environmentId: string): number {
    return this.resetsOf(environmentId)
  }

  private resetsOf(environmentId: string): number {
    return this.resets.get(environmentId) ?? 0
  }

  /** Hold capped failures until the repair window reopens. */
  private stand(environmentId: string, revision: number, epoch: number, error: Error): Error {
    if (this.resetsOf(environmentId) !== epoch) {
      return error
    }
    const recent = this.recentAttempts(environmentId)
    const capSpent = recent.length >= MAX_PAIRING_REPAIRS_PER_WINDOW
    this.standing.set(environmentId, {
      // Later callers need the cap reason until repair becomes possible again.
      error:
        capSpent && error instanceof HivewarddManagedPairingRepairFailedError
          ? capSpentError(recent.length)
          : error,
      revision,
      until: capSpent
        ? recent[0] + PAIRING_REPAIR_WINDOW_MS
        : this.deps.now() + PAIRING_REPAIR_FAILURE_HOLD_MS
    })
    return error
  }
}

export type ManagedHivewarddPairingGate = Pick<
  ManagedHivewarddPairingRepairs,
  'standingFailure' | 'repair' | 'recordRefusedAfterRepair' | 'resetEpoch' | 'forgetFailures'
>

function capSpentError(attempts: number): Error {
  return new HivewarddManagedPairingRepairFailedError(
    `it tried ${attempts} times in ${PAIRING_REPAIR_WINDOW_MS / 60_000} minutes ` +
      'without the server accepting a pairing'
  )
}

function publishedPairingCode(
  readiness: ServeReadiness | null,
  localPort: number,
  fail: (error: Error) => Error
): string {
  if (!readiness) {
    throw fail(
      new HivewarddManagedPairingRepairFailedError(
        "the server hasn't published a pairing HiveWard can read"
      )
    )
  }
  if (!readiness.pairing.available) {
    throw fail(
      new HivewarddManagedPairingRepairFailedError(
        `the server isn't offering a pairing (${readiness.pairing.guidance})`
      )
    )
  }
  try {
    return tunneledHivewarddPairingCode(readiness, localPort)
  } catch (error) {
    throw fail(new HivewarddManagedPairingRepairFailedError(errorMessage(error)))
  }
}
