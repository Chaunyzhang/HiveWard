/** Adopt serving unrecorded hivewardd under the activation fence only when lock, readiness and installed build identify the same process. Never kill it without census; launching another loses the instance lock. Normal update admission handles version changes. */
import {
  HIVEWARDD_LOCK_FILE_NAME,
  parseHivewarddInstanceLockRecord,
  type HivewarddLockRecord
} from '../hivewardd/hivewardd-instance-lock'
import { compareHivewarddProcessIdentity } from '../hivewardd/hivewardd-process-start-time'
import type { HivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'
import {
  readHivewarddActivationRecord,
  writeHivewarddActivationRecord
} from '../managed-server/activation/hivewardd-activation-record-store'
import { evaluateHivewarddActivation } from '../managed-server/activation/hivewardd-activation-gate'
import { withHivewarddActivationLock } from '../managed-server/activation/hivewardd-activation-lock'
import { sameHivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-transaction'
import { readHivewarddActivationTransaction } from '../managed-server/activation/hivewardd-activation-transaction-store'
import { readRemoteHivewarddManagedStopTarget } from '../managed-server/lifecycle/hivewardd-managed-remote-stop'
import {
  hivewarddSlotDir,
  resolveHivewarddSlotIdentity,
  type HivewarddSlotOptions
} from '../ssh/hivewardd-recovery-slot'
import { HIVEWARDD_PID_FILENAME } from '../managed-server/install/hivewardd-remote-host-support'
import {
  parseHivewarddReadinessWaitOutput,
  readHivewarddReadinessNowCommand
} from '../managed-server/install/hivewardd-remote-readiness-wait'
import { readBoundedHivewarddRemoteRecord } from '../managed-server/install/hivewardd-remote-record-file'
import { execHivewarddRemote } from '../managed-server/install/hivewardd-remote-runtime-control'
import {
  HIVEWARDD_INSTALL_MODEL,
  remoteInstallDirName,
  remoteInstallVersionDirRegex
} from '../managed-server/install/remote-install-model'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import {
  readWslGuestIdentity,
  wslGuestHivewarddIncarnation,
  type WslGuestIdentity
} from './wsl-guest-process-identity'
import type { WslHivewarddInstanceLockRead } from './wsl-hivewardd-connect-state-snapshot'

const LOCK_RECORD_MAX_BYTES = 64 * 1024
const UNRECORDED_HIVEWARDD_CODE = 'wsl_hivewardd_unrecorded_instance_unverifiable'

export type WslHivewarddAdoption =
  | { outcome: 'none' }
  | { outcome: 'adopted'; version: string; pid: number; record: HivewarddActivationRecord }

export class WslHivewarddUnrecordedInstanceError extends Error {
  readonly code = UNRECORDED_HIVEWARDD_CODE
  constructor(message: string) {
    super(message)
    this.name = 'WslHivewarddUnrecordedInstanceError'
  }
}

type LockHolder = { pid: number; version: string }

async function readLiveLockHolder(
  slot: HivewarddSlotOptions,
  preRead?: WslHivewarddInstanceLockRead
): Promise<LockHolder | null> {
  const lockPath = joinRemotePath(slot.host, slot.userDataDir, HIVEWARDD_LOCK_FILE_NAME)
  const read =
    preRead ?? (await readBoundedHivewarddRemoteRecord(slot, lockPath, LOCK_RECORD_MAX_BYTES))
  const lock = read.state === 'present' ? parseHivewarddInstanceLockRecord(read.raw) : null
  // Desktop-role or malformed locks identify no hivewardd to adopt.
  if (!lock || lock.role === 'desktop') {
    return null
  }
  // Adopt only proven-live holders; otherwise let the host's instance lock arbitrate launch.
  // The snapshot's identity counts only if it was read for this same pid.
  const known =
    preRead?.state === 'present' && preRead.holder?.pid === lock.pid ? preRead.holder.guest : null
  return (await lockHolderLiveness(slot, lock, known)) === 'live'
    ? { pid: lock.pid, version: lock.version }
    : null
}

type LockHolderLiveness = 'live' | 'unverifiable' | 'exited'

/** A PID is no identity after a distro restart reuses it: the lock's boot id and start ticks are. */
async function lockHolderLiveness(
  slot: HivewarddSlotOptions,
  lock: HivewarddLockRecord,
  known: WslGuestIdentity | null = null
): Promise<LockHolderLiveness> {
  const guest = known ?? (await readWslGuestIdentity(slot.conn, lock.pid))
  if (!guest) {
    return 'unverifiable'
  }
  const incarnation = wslGuestHivewarddIncarnation(guest)
  // The guest answered, and no process has that PID.
  if (!incarnation) {
    return 'exited'
  }
  // Compare boot IDs case-insensitively because readers normalize them.
  const recorded = lock.bootId ? { ...lock, bootId: lock.bootId.toLowerCase() } : lock
  const verdict = compareHivewarddProcessIdentity(lock.pid, recorded, {
    incarnation: () => incarnation,
    // Ignore wall-clock starts: guest clocks jump after host sleep.
    startedAtMs: () => null,
    platform: 'linux'
  })
  return verdict === 'matches' ? 'live' : verdict === 'differs' ? 'exited' : 'unverifiable'
}

async function readSlotPid(slot: HivewarddSlotOptions, version: string): Promise<number | null> {
  const pidFile = joinRemotePath(slot.host, hivewarddSlotDir(slot, version), HIVEWARDD_PID_FILENAME)
  const raw = await execHivewarddRemote(slot, `cat ${quotePosixShell(pidFile)} 2>/dev/null || true`)
  const pid = Number.parseInt(raw.trim(), 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** The holder's slot must publish readiness for this pid, from the build installed there. */
async function proveHolderServesItsSlot(slot: HivewarddSlotOptions, holder: LockHolder): Promise<void> {
  const label = `An hivewardd (pid ${holder.pid}, ${holder.version}) is running in this distro but is not the recorded one`
  const dirName = remoteInstallDirName(HIVEWARDD_INSTALL_MODEL, holder.version)
  if (!remoteInstallVersionDirRegex(HIVEWARDD_INSTALL_MODEL).test(dirName)) {
    throw new WslHivewarddUnrecordedInstanceError(`${label}, and its version is not a slot name.`)
  }
  const target = await readRemoteHivewarddManagedStopTarget(slot, holder.version)
  if (target.state !== 'ready' || target.context.instance.pid !== holder.pid) {
    throw new WslHivewarddUnrecordedInstanceError(
      `${label}, and it cannot be identified: ${target.state === 'refused' ? target.reason : 'its readiness names another process.'}`
    )
  }
  const identity = await resolveHivewarddSlotIdentity(slot, holder.version)
  const readiness = parseHivewarddReadinessWaitOutput(
    slot.host,
    await execHivewarddRemote(slot, readHivewarddReadinessNowCommand(slot.host, identity.remoteDir))
  )
  const verdict = evaluateHivewarddActivation(
    readiness.state === 'ready' ? readiness.readiness : null,
    {
      buildHash: identity.buildHash,
      fullVersion: identity.version
    }
  )
  if (verdict.decision === 'reject') {
    throw new WslHivewarddUnrecordedInstanceError(`${label}, and ${verdict.reason}`)
  }
}

function adoptedRecord(
  record: HivewarddActivationRecord,
  version: string,
  now: Date
): HivewarddActivationRecord {
  if (record.active === version) {
    return record
  }
  const { activeAppVersion, previousAppVersion: _previousAppVersion, ...rest } = record
  return {
    ...rest,
    active: version,
    previous: record.active ?? record.previous,
    ...(record.active && activeAppVersion ? { previousAppVersion: activeAppVersion } : {}),
    activatedAt: now.toISOString(),
    // Prelaunch snapshot belongs to another activation; rollback must not restore it.
    snapshot: null
  }
}

/** Adopt lock owners missing from record/pid file only with proof; otherwise refuse rather than launch into an occupied instance lock. */
export async function adoptUnrecordedWslHivewardd(
  slot: HivewarddSlotOptions,
  record: HivewarddActivationRecord,
  now: () => Date = () => new Date(),
  /** This connect's snapshot of the lock; the fenced re-check below always reads the host. */
  preReadLock?: WslHivewarddInstanceLockRead
): Promise<WslHivewarddAdoption> {
  const holder = await readLiveLockHolder(slot, preReadLock)
  if (!holder) {
    return { outcome: 'none' }
  }
  if (
    record.active === holder.version &&
    (await readSlotPid(slot, holder.version)) === holder.pid
  ) {
    return { outcome: 'none' }
  }
  await proveHolderServesItsSlot(slot, holder)
  return withHivewarddActivationLock(
    slot,
    async () => {
      const current = await readHivewarddActivationRecord(slot)
      if (!sameHivewarddActivationRecord(current, record)) {
        throw new WslHivewarddUnrecordedInstanceError(
          'The activation record changed while an unrecorded hivewardd was being adopted. Retry.'
        )
      }
      if (await readHivewarddActivationTransaction(slot)) {
        throw new WslHivewarddUnrecordedInstanceError(
          'An interrupted activation is pending, so an unrecorded hivewardd cannot be adopted yet.'
        )
      }
      const again = await readLiveLockHolder(slot)
      if (again?.pid !== holder.pid || again.version !== holder.version) {
        throw new WslHivewarddUnrecordedInstanceError(
          'The unrecorded hivewardd changed while it was being adopted. Retry.'
        )
      }
      const pidFile = joinRemotePath(
        slot.host,
        hivewarddSlotDir(slot, holder.version),
        HIVEWARDD_PID_FILENAME
      )
      await execHivewarddRemote(
        slot,
        `(umask 077 && printf '%s\\n' ${String(holder.pid)} > ${quotePosixShell(pidFile)})`
      )
      const next = adoptedRecord(current, holder.version, now())
      if (next !== current) {
        await writeHivewarddActivationRecord(slot, next)
      }
      return {
        outcome: 'adopted' as const,
        version: holder.version,
        pid: holder.pid,
        record: next
      }
    },
    () => {
      throw new WslHivewarddUnrecordedInstanceError(
        'Another HiveWard is changing this distro’s server, so an unrecorded hivewardd cannot be adopted now.'
      )
    }
  )
}
