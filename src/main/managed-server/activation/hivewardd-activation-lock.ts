// Retain journal and fence until one serving slot is proven; release removes both, while only recovery may take retained state over.
import { randomUUID } from 'node:crypto'
import {
  execHivewarddRemote,
  withoutAbortSignal,
  type HivewarddRemoteExecTarget
} from '../install/hivewardd-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import { acquireInstallLock, RemoteInstallLockBusyError } from '../install/remote-install-lock'
import {
  orphanInstallLockCommand,
  probeInstallLockExistsCommand
} from '../install/remote-install-lock-commands'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  HIVEWARDD_FENCE_OWNER_FILENAME,
  posixHivewarddFenceOwnedTest,
  runWithHivewarddFence,
  type HivewarddFence
} from './hivewardd-activation-fence-scope'
import { hivewarddRemoteBaseDir, hivewarddWindowsHomeOpCommand } from '../install/hivewardd-remote-windows-node'
import { forgetHeldHivewarddFence, rememberHeldHivewarddFence } from '../../ssh/hivewardd-held-fence-tokens'
import { exitedOwnLockProof } from '../../ssh/hivewardd-exited-own-lock'
import { isWindowsRemoteHost } from '../../ssh/ssh-remote-platform'
import {
  hivewarddActivationFenceLockDir,
  hivewarddActivationTransactionPath,
  hivewarddActivationTransactionRoot
} from './hivewardd-activation-transaction'
import {
  readHivewarddActivationTransaction,
  writeHivewarddActivationTransaction
} from './hivewardd-activation-transaction-store'

const HIVEWARDD_ACTIVATION_MAX_READINESS_TIMEOUT_MS = 5 * 60_000

export type HivewarddActivationLockOptions = HivewarddRemoteExecTarget & { remoteHome: string }

export type HivewarddActivationLockControl = {
  /** Retain on throw once a journal describes possibly changed host state. */
  retainOnError(): void
  /** Retain on success too when serving-slot ownership remains unproven. */
  retain(): void
  /** Release even on later throw once the recorded slot is proven restored. */
  recovered(): void
}

/** Bound readiness below the stale-lock window so live waiters do not look abandoned. */
export function resolveHivewarddActivationReadinessTimeout(
  configured: number | undefined,
  fallback: number
): number {
  const timeout = configured ?? fallback
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > HIVEWARDD_ACTIVATION_MAX_READINESS_TIMEOUT_MS
  ) {
    throw new Error(
      `hivewardd readiness timeout must be an integer from 1 to ${HIVEWARDD_ACTIVATION_MAX_READINESS_TIMEOUT_MS}ms`
    )
  }
  return timeout
}

// Tolerate brief concurrent work without stalling the lifecycle queue for a full stale window.
const HIVEWARDD_ACTIVATION_FENCE_WAIT_MS = 5_000

/** Report held after a brief wait; token identifies this generation for subsequent recovery proof. */
export async function withHivewarddActivationLock<T>(
  options: HivewarddActivationLockOptions,
  run: (control: HivewarddActivationLockControl) => Promise<T>,
  held: () => T | Promise<T>,
  token: string = randomUUID()
): Promise<T> {
  const lockRoot = hivewarddActivationTransactionRoot(options.host, options.remoteHome)
  rememberHeldHivewarddFence(token)
  try {
    await acquireInstallLock(options.conn, lockRoot, options.host, {
      signal: options.signal,
      relayGcClaim: false,
      // Unresolved state ownership cannot become safe through age alone.
      allowStaleTakeover: false,
      waitTimeoutMs: HIVEWARDD_ACTIVATION_FENCE_WAIT_MS,
      owner: { fileName: HIVEWARDD_FENCE_OWNER_FILENAME, token }
    })
  } catch (error) {
    if (error instanceof RemoteInstallLockBusyError) {
      forgetHeldHivewarddFence(token)
      return await held()
    }
    throw error
  }
  const fence = activationFence(options, token)
  let retainOnError = false
  let retain = false
  try {
    const result = await runWithHivewarddFence(fence, () =>
      run({
        retainOnError: () => {
          retainOnError = true
        },
        retain: () => {
          retain = true
        },
        recovered: () => {
          retainOnError = false
        }
      })
    )
    await (retain ? orphanRetainedFence(options, fence) : releaseActivationFence(options, fence))
    return result
  } catch (error) {
    // Unconfirmed host work may still mutate state, so do not age its fence.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await (
        retainOnError ? orphanRetainedFence(options, fence) : releaseActivationFence(options, fence)
      ).catch((releaseError: unknown) => {
        console.warn(
          `[hivewardd] Failed to release activation lock after an error: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
        )
      })
    }
    throw error
  }
}

/** Recover stale, previous-boot or proven exited-own fences; a fresh live owner remains busy. */
export async function withStaleHivewarddActivationRecoveryLock<T>(
  options: HivewarddActivationLockOptions,
  run: (control: Pick<HivewarddActivationLockControl, 'retain'>) => Promise<T>
): Promise<T> {
  const lockRoot = hivewarddActivationTransactionRoot(options.host, options.remoteHome)
  const token = randomUUID()
  rememberHeldHivewarddFence(token)
  // Takeover replaces the token so the predecessor can neither act nor release.
  await acquireInstallLock(options.conn, lockRoot, options.host, {
    signal: options.signal,
    relayGcClaim: false,
    allowStaleTakeover: true,
    waitTimeoutMs: 0,
    owner: { fileName: HIVEWARDD_FENCE_OWNER_FILENAME, token },
    exitedOwner: exitedOwnLockProof(options, {
      baseDir: hivewarddRemoteBaseDir(options.host, options.remoteHome),
      guardsStateMutation: true
    })
  }).catch((error: unknown) => {
    if (error instanceof RemoteInstallLockBusyError) {
      forgetHeldHivewarddFence(token)
    }
    throw error
  })
  const fence = activationFence(options, token)
  let retain = false
  let result: T
  try {
    result = await runWithHivewarddFence(fence, async () => {
      await adoptInterruptedJournal(options)
      return run({ retain: () => (retain = true) })
    })
  } catch (error) {
    // Failed recovery retains ownership fencing until one serving slot is proven.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await orphanRetainedFence(options, fence).catch(() => undefined)
    }
    throw error
  }
  await (retain ? orphanRetainedFence(options, fence) : releaseActivationFence(options, fence))
  return result
}

/** Adopt the journal into this generation so release recognizes it as owned. */
async function adoptInterruptedJournal(options: HivewarddActivationLockOptions): Promise<void> {
  const journal = await readHivewarddActivationTransaction(options).catch(() => null)
  if (journal) {
    await writeHivewarddActivationTransaction(options, journal)
  }
}

function activationFence(options: HivewarddActivationLockOptions, token: string): HivewarddFence {
  return { lockDir: hivewarddActivationFenceLockDir(options.host, options.remoteHome), token }
}

/** Age retained, finished work for immediate recovery; token guards prevent aging a successor's fence. */
async function orphanRetainedFence(
  options: HivewarddActivationLockOptions,
  fence: HivewarddFence
): Promise<void> {
  try {
    await runWithHivewarddFence(fence, () =>
      execHivewarddRemote(
        withoutAbortSignal(options),
        orphanInstallLockCommand(options.host, fence.lockDir)
      )
    )
    forgetHeldHivewarddFence(fence.token)
  } catch (error) {
    // Failed orphan marking keeps the fence held until its normal stale window expires.
    console.warn(
      `[hivewardd] Could not mark a retained activation fence as ownerless: ${String(error)}`
    )
  }
}

/** Failed probes throw; unreadable must never mean unfenced. */
export async function hivewarddActivationFenceExists(
  options: HivewarddActivationLockOptions
): Promise<boolean> {
  const lockDir = hivewarddActivationFenceLockDir(options.host, options.remoteHome)
  const answer = (
    await execHivewarddRemote(options, probeInstallLockExistsCommand(options.host, lockDir))
  ).trim()
  if (answer !== 'LOCKED' && answer !== 'OPEN') {
    throw new Error('The activation fence probe returned no verifiable answer.')
  }
  return answer === 'LOCKED'
}

export function releaseHivewarddActivationFence(
  options: HivewarddActivationLockOptions,
  token: string
): Promise<void> {
  return releaseActivationFence(options, activationFence(options, token))
}

/** Remove only this generation: journal first, then rename the owned lock aside before deletion. */
async function releaseActivationFence(
  options: HivewarddActivationLockOptions,
  fence: HivewarddFence
): Promise<void> {
  const lockRoot = hivewarddActivationTransactionRoot(options.host, options.remoteHome)
  const journal = hivewarddActivationTransactionPath(options.host, options.remoteHome)
  // Cancellation must not prevent releasing a fence already proven unnecessary.
  const target = withoutAbortSignal(options)
  const command = isWindowsRemoteHost(options.host)
    ? hivewarddWindowsHomeOpCommand(options.host, options.remoteHome, 'fence-release', [
        fence.lockDir,
        journal,
        fence.token
      ])
    : posixReleaseFenceCommand(fence, journal, lockRoot)
  const answer = (await execHivewarddRemote(target, command)).trim()
  forgetHeldHivewarddFence(fence.token)
  if (answer.endsWith('SUPERSEDED')) {
    console.warn('[hivewardd] A newer run had taken this activation fence over; it was left in place.')
  }
}

/** Rename then check ownership, restoring foreign entries so stalled release cannot delete a successor's state. */
export function posixReleaseFenceCommand(
  fence: HivewarddFence,
  journal: string,
  lockRoot: string
): string {
  const lock = quotePosixShell(fence.lockDir)
  const journalPath = quotePosixShell(journal)
  const stamp = quotePosixShell(journalFenceStamp(fence.token))
  return [
    `${posixHivewarddFenceOwnedTest(fence)} || { echo SUPERSEDED; exit 0; };`,
    `ja=${journalPath}.release.$$;`,
    `if mv ${journalPath} "$ja" 2>/dev/null; then`,
    `grep -qF ${stamp} "$ja" || mv -n "$ja" ${journalPath} 2>/dev/null; rm -f "$ja"; fi;`,
    `la=${lock}.released.$$;`,
    `if mv ${lock} "$la" 2>/dev/null; then`,
    `if [ "$(cat "$la"/${HIVEWARDD_FENCE_OWNER_FILENAME} 2>/dev/null)" = ${quotePosixShell(fence.token)} ]; then rm -rf "$la";`,
    `else mv -n "$la" ${lock} 2>/dev/null; fi; fi;`,
    `rmdir ${quotePosixShell(lockRoot)} 2>/dev/null; echo RELEASED`
  ].join(' ')
}

function journalFenceStamp(token: string): string {
  return `"fenceToken": ${JSON.stringify(token)}`
}
