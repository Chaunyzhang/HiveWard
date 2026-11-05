// Hivewardd exit does not prove terminal exit: the terminal daemon can outlive the server.
import { HIVEWARDD_FENCE_OWNER_FILENAME } from '../activation/hivewardd-activation-fence-scope'
import type { ServeReadiness } from '../../server/serve-readiness'
import { readHivewarddActivationRecord } from '../activation/hivewardd-activation-record-store'
import { randomUUID } from 'node:crypto'
import {
  hivewarddActivationFenceExists,
  releaseHivewarddActivationFence,
  withHivewarddActivationLock
} from '../activation/hivewardd-activation-lock'
import { hivewarddLivenessProvenExited } from '../install/hivewardd-remote-launch'
import { readBoundedHivewarddRemoteRecord } from '../install/hivewardd-remote-record-file'
import { hivewarddActivationFenceLockDir } from '../activation/hivewardd-activation-transaction'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'

import { readHivewarddActivationTransaction } from '../activation/hivewardd-activation-transaction-store'
import {
  HIVEWARDD_RECOVERY_UNVERIFIABLE_CODE,
  recoverInterruptedHivewarddActivation
} from '../activation/hivewardd-activation-recovery'
import {
  ensureHivewarddSlotServing,
  hivewarddSlotDir,
  resolveHivewarddSlotIdentity,
  slotLiveness,
  type HivewarddSlotOptions
} from '../../ssh/hivewardd-recovery-slot'

type HivewarddManagedWake =
  | { outcome: 'serving' | 'not-activated' | 'unverifiable' }
  | { outcome: 'fenced' }
  | { outcome: 'started'; readiness: ServeReadiness }
  | { outcome: 'recovery-refused'; reason: string }

/** Start only proven-stopped active slots; leave live or unverifiable processes alone. */
export function wakeStoppedManagedHivewardd(
  options: HivewarddSlotOptions,
  onStarting: () => void = () => {}
): Promise<HivewarddManagedWake> {
  return serializedWake(options, (host) => wakeAfterPrior(options, host, onStarting))
}

/**
 * WSL's same-version connect: one fence both confirms `expectActive` is still the active slot
 * and starts it if proven stopped. 'replan' means another version is active now; 'fenced' that
 * the fence was busy. Either way the caller takes the full deploy and wake.
 */
export function wakeExpectedHivewarddUnderOneFence(
  options: HivewarddSlotOptions,
  expectActive: string
): Promise<HivewarddManagedWake | { outcome: 'replan' }> {
  return serializedWake(options, async (host) => {
    // An earlier wake's dropped fence is reclaimed only by the full wake, which knows its token.
    if (interruptedWakes.has(host)) {
      return { outcome: 'fenced' }
    }
    // Record ownership before acquisition, as the wake does: a dropped reply leaves a fence only it can reclaim.
    const token = randomUUID()
    interruptedWakes.set(host, token)
    const result = await withHivewarddActivationLock(
      options,
      async (): Promise<HivewarddManagedWake | { outcome: 'replan' }> => {
        if ((await readHivewarddActivationRecord(options)).active !== expectActive) {
          return { outcome: 'replan' }
        }
        const liveness = await slotLiveness(options, hivewarddSlotDir(options, expectActive))
        if (!hivewarddLivenessProvenExited(liveness)) {
          return { outcome: liveness === 'LIVE' ? 'serving' : 'unverifiable' }
        }
        const identity = await resolveHivewarddSlotIdentity(options, expectActive)
        return { outcome: 'started', readiness: await ensureHivewarddSlotServing(options, identity) }
      },
      (): HivewarddManagedWake => ({ outcome: 'fenced' }),
      token
    )
    if (interruptedWakes.get(host) === token) {
      interruptedWakes.delete(host)
    }
    return result
  })
}

function serializedWake<T>(
  options: HivewarddSlotOptions,
  run: (host: string) => Promise<T>
): Promise<T> {
  const host = wakeHostKey(options)
  // Serialize per host before remote work so reconnect cannot race an earlier wake's unexplained fence.
  const prior = runningWakes.get(host)
  const wake = (async (): Promise<T> => {
    await prior?.catch(() => {})
    return run(host)
  })()
  runningWakes.set(host, wake)
  void wake
    .catch(() => {})
    .finally(() => {
      if (runningWakes.get(host) === wake) {
        runningWakes.delete(host)
      }
    })
  return wake
}

async function wakeAfterPrior(
  options: HivewarddSlotOptions,
  host: string,
  onStarting: () => void
): Promise<HivewarddManagedWake> {
  const before = await readHivewarddActivationRecord(options)
  if (!before.active) {
    return { outcome: 'not-activated' }
  }
  const liveness = await slotLiveness(options, hivewarddSlotDir(options, before.active))
  if (!hivewarddLivenessProvenExited(liveness)) {
    await forgetSettledInterruptedWake(options, host, liveness === 'LIVE')
    return { outcome: liveness === 'LIVE' ? 'serving' : 'unverifiable' }
  }
  if (!(await hivewarddActivationFenceExists(options))) {
    interruptedWakes.delete(host)
  } else if (!(await releaseOwnInterruptedWakeFence(options, host))) {
    const recovered = await recoverAbandonedFence(options, onStarting)
    if (recovered) {
      return recovered
    }
  }
  // Record ownership before acquisition: dropped replies can leave fences only this token can reclaim.
  const token = randomUUID()
  interruptedWakes.set(host, token)
  const result = await withHivewarddActivationLock(
    options,
    async (): Promise<HivewarddManagedWake> => {
      // Other clients may change the active slot; reread under the fence.
      const active = (await readHivewarddActivationRecord(options)).active
      if (!active) {
        return { outcome: 'not-activated' }
      }
      const identity = await resolveHivewarddSlotIdentity(options, active)
      onStarting()
      return { outcome: 'started', readiness: await ensureHivewarddSlotServing(options, identity) }
    },
    (): HivewarddManagedWake => ({ outcome: 'fenced' }),
    token
  )
  if (interruptedWakes.get(host) === token) {
    interruptedWakes.delete(host)
  }
  return result
}

/** Recover abandoned journals under stale, previous-boot or proven-exited fences; busy runs retain ownership. */
async function recoverAbandonedFence(
  options: HivewarddSlotOptions,
  onStarting: () => void
): Promise<HivewarddManagedWake | null> {
  const recovery = await recoverInterruptedHivewarddActivation(options)
  switch (recovery.outcome) {
    case 'none':
      return null
    case 'pending':
      return { outcome: 'fenced' }
    case 'refused':
      // Retry unverifiable recovery at the next fence check, as with a busy owner.
      return recovery.code === HIVEWARDD_RECOVERY_UNVERIFIABLE_CODE
        ? { outcome: 'fenced' }
        : { outcome: 'recovery-refused', reason: recovery.reason }
    case 'recovered':
      if (!recovery.readiness) {
        return { outcome: 'not-activated' }
      }
      onStarting()
      return { outcome: 'started', readiness: recovery.readiness }
  }
}

const runningWakes = new Map<string, Promise<unknown>>()

const interruptedWakes = new Map<string, string>()

function wakeOwnerPath(options: HivewarddSlotOptions): string {
  return joinRemotePath(
    options.host,
    hivewarddActivationFenceLockDir(options.host, options.remoteHome),
    HIVEWARDD_FENCE_OWNER_FILENAME
  )
}

function wakeHostKey(options: HivewarddSlotOptions): string {
  return `${options.conn.getTarget().id}\0${options.remoteHome}`
}

/**
 * A serving slot skips the fence branch that clears an interrupted wake's token, which would
 * keep the one-fence wake off until restart. Forget it once its fence is gone or another owner's;
 * an unanswered probe proves neither, so the token stays. A fence still ours whose dropped launch
 * did start the slot (proven LIVE, no journal) is released, or deploys would wait for it to age out.
 */
async function forgetSettledInterruptedWake(
  options: HivewarddSlotOptions,
  host: string,
  slotLive: boolean
): Promise<void> {
  const token = interruptedWakes.get(host)
  if (!token) {
    return
  }
  try {
    const owner = (await hivewarddActivationFenceExists(options))
      ? await readBoundedHivewarddRemoteRecord(options, wakeOwnerPath(options), 64)
      : null
    const ours = owner?.state === 'present' && owner.raw.trim() === token
    if (ours && slotLive && !(await readHivewarddActivationTransaction(options))) {
      // The release command re-proves the owner token on the host before removing anything.
      await releaseHivewarddActivationFence(options, token)
    } else if (ours || owner?.state === 'absent') {
      return
    }
    if (interruptedWakes.get(host) === token) {
      interruptedWakes.delete(host)
    }
  } catch {
    // Unverifiable: keep the token for the next wake.
  }
}

/** Reclaim only this client's journal-free interrupted fence after proving slot exit. */
async function releaseOwnInterruptedWakeFence(
  options: HivewarddSlotOptions,
  host: string
): Promise<boolean> {
  const token = interruptedWakes.get(host)
  if (!token || (await readHivewarddActivationTransaction(options))) {
    return false
  }
  // A new owner may not have written its token yet; absence cannot prove this fence ours.
  const owner = await readBoundedHivewarddRemoteRecord(options, wakeOwnerPath(options), 64)
  if (owner.state !== 'present' || owner.raw.trim() !== token) {
    interruptedWakes.delete(host)
    return false
  }
  await releaseHivewarddActivationFence(options, token)
  interruptedWakes.delete(host)
  return true
}
