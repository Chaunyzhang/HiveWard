// Lock before profile load to prevent concurrent writers; terminal daemons own separate endpoints
// and deliberately survive runtime lock release and restart.
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import {
  compareHivewarddProcessIdentity,
  readHivewarddProcessIncarnation,
  readHivewarddProcessName,
  readHivewarddProcessStartedAtMs,
  type HivewarddProcessIdentityVerdict,
  type HivewarddProcessIncarnation
} from './hivewardd-process-start-time'
import {
  assertHivewarddDataRootIsPrivate,
  HivewarddInstanceLockError,
  type HivewarddDataRootPrivacyHooks
} from './hivewardd-data-root-privacy'
import { hasErrorCode, isProcessAlive } from '../daemon/daemon-process-inspection'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { hivewarddDataRootIsOnLocalDisk } from './hivewardd-data-root-locality'
import type { HivewarddReclaimHintRuntime } from '../../shared/hivewardd-stale-lock-reclaim'
import {
  hivewarddLockHolderLocality,
  hivewarddLockHolderUnverifiableError
} from './hivewardd-lock-holder-locality'
import {
  hivewarddLockPeer,
  hivewarddLockSelf,
  hivewarddPeerIsLiveCloneMachine,
  startHivewarddLockHeartbeat
} from './hivewardd-lock-clone-machine'
import {
  MAX_HIVEWARDD_LOCK_BYTES,
  readBoundedLockFile,
  reclaimAndPublish,
  unlinkQuietly,
  type HivewarddLockRecoveryOwner
} from './hivewardd-instance-lock-reclaim'

export const HIVEWARDD_LOCK_FILE_NAME = 'hivewardd.lock'
// Allow old torn writes time to complete before treating garbled records as abandoned.
const GARBLED_LOCK_GRACE_MS = 10_000

const HivewarddLockRecordSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Null means PID alone supplies the weaker fence. */
  startedAtMs: z.number().finite().nonnegative().nullable(),
  /** Drift-free Linux identity; tolerate unknown future encodings without losing the whole record. */
  linuxStartTicks: z.string().regex(/^\d+$/).max(32).optional().catch(undefined),
  bootId: z.string().min(1).max(255).optional().catch(undefined),
  identity: z.string().min(1).max(1_024),
  version: z.string().min(1).max(255),
  acquiredAt: z.iso.datetime({ offset: true }),
  nonce: z.string().min(1).max(255),
  /** Older pre-desktop-sharing records omit role. */
  role: z.enum(['hivewardd', 'desktop']).optional(),
  /** Shared homes require machine identity: foreign PIDs establish no local liveness. */
  machineIdentity: z.string().min(1).max(255).optional().catch(undefined),
  /** Optional legacy-compatible hostname for stale-lock reclaim hints. */
  host: z.string().min(1).max(255).optional().catch(undefined)
})

export type HivewarddLockRecord = z.infer<typeof HivewarddLockRecordSchema>

/** Unreadable/malformed/oversized/absent returns null; this does not prove the lock is free. */
export function readHivewarddInstanceLockRecord(path: string): HivewarddLockRecord | null {
  return parseHivewarddInstanceLockRecord(readBoundedLockFile(path) ?? '')
}

export type HivewarddInstanceLock = {
  readonly path: string
  readonly record: HivewarddLockRecord
  release(): void
}

export type HivewarddInstanceLockHooks = HivewarddDataRootPrivacyHooks & {
  identity?: () => string
  version?: () => string
  now?: () => Date
  /** EPERM still proves the process exists. */
  processIsAlive?: (pid: number) => boolean
  startedAtMs?: (pid: number) => number | null
  incarnation?: (pid: number) => HivewarddProcessIncarnation | null
  ownerUid?: (pid: number) => number | null
  processName?: (pid: number) => string | null
  /** Only differs can reject a live PID’s identity. */
  holderIdentity?: (record: HivewarddLockRecord) => HivewarddProcessIdentityVerdict
  /** Desktop callers must first hold Electron’s single-instance lock to reclaim desktop records. */
  role?: 'hivewardd' | 'desktop'
  machineIdentity?: () => string | null
  /** Establishes locality for legacy machine-less records. */
  dataRootIsOnLocalDisk?: (dataRoot: string) => boolean
  /** Explicit stale-reclaim confirmation permits judging otherwise unverifiable PIDs locally. */
  reclaimConfirmed?: (record: HivewarddLockRecord, role: 'holder' | 'recovery-owner') => boolean
  reclaimHintRuntime?: HivewarddReclaimHintRuntime | null
  bootStartedAtMs?: () => number | null
}

function defaultIdentity(): string {
  // POSIX names can repeat across containers; filesystem permissions enforce numeric UIDs.
  return process.platform === 'win32'
    ? (userInfo().username ?? 'unknown')
    : String(process.getuid?.() ?? 'unknown')
}

export function parseHivewarddInstanceLockRecord(content: string): HivewarddLockRecord | null {
  try {
    const result = HivewarddLockRecordSchema.safeParse(JSON.parse(content))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/** Reclaim dead holders only; preserve live or foreign-identity ownership. */
export function acquireHivewarddInstanceLock(
  dataRoot: string,
  hooks: HivewarddInstanceLockHooks = {}
): HivewarddInstanceLock {
  const identity = (hooks.identity ?? defaultIdentity)()
  const isAlive = hooks.processIsAlive ?? isProcessAlive
  const readStartedAt = hooks.startedAtMs ?? readHivewarddProcessStartedAtMs
  const readIncarnation = hooks.incarnation ?? readHivewarddProcessIncarnation
  const holderIdentity =
    hooks.holderIdentity ??
    ((holder: HivewarddLockRecord) =>
      compareHivewarddProcessIdentity(holder.pid, holder, {
        startedAtMs: readStartedAt,
        incarnation: readIncarnation,
        ownerUid: hooks.ownerUid,
        platform: hooks.platform
      }))

  try {
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new HivewarddInstanceLockError(
      'hivewardd_data_root_unusable',
      `Cannot create the hivewardd data root ${dataRoot}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  // Desktop profiles retain existing permissions; hivewardd tightens its own roots.
  if ((hooks.role ?? 'hivewardd') === 'hivewardd') {
    assertHivewarddDataRootIsPrivate(dataRoot, hooks)
  }

  const lockPath = join(dataRoot, HIVEWARDD_LOCK_FILE_NAME)
  const machineIdentity = (hooks.machineIdentity ?? profileStateAccessMachineIdentity)()
  const record: HivewarddLockRecord = {
    pid: process.pid,
    startedAtMs: readStartedAt(process.pid),
    ...readIncarnation(process.pid),
    identity,
    version: (hooks.version ?? (() => process.env.HIVEWARD_VERSION ?? 'unknown'))(),
    acquiredAt: (hooks.now ?? (() => new Date()))().toISOString(),
    nonce: randomUUID(),
    role: hooks.role ?? 'hivewardd',
    ...(machineIdentity ? { machineIdentity } : {}),
    host: hostname()
  }
  const serialized = JSON.stringify(record)
  const platform = hooks.platform ?? process.platform
  const self = hivewarddLockSelf(record, Date.parse(record.acquiredAt), hooks.bootStartedAtMs?.())

  // Stage then hard-link so canonical records are always complete.
  const publish = (): boolean => {
    const staged = `${lockPath}.staged-${process.pid}-${randomUUID()}`
    try {
      writeFileSync(staged, serialized, { flag: 'wx', mode: 0o600 })
      linkSync(staged, lockPath)
      return true
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        return false
      }
      throw new HivewarddInstanceLockError(
        'hivewardd_data_root_unusable',
        `Cannot write the hivewardd instance lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      unlinkQuietly(staged)
    }
  }

  if (publish()) {
    return makeLock(lockPath, record)
  }

  const dataRootIsLocal = (): boolean =>
    (hooks.dataRootIsOnLocalDisk ?? hivewarddDataRootIsOnLocalDisk)(dataRoot)
  const judgedHere = (holder: HivewarddLockRecord, role: 'holder' | 'recovery-owner'): boolean => {
    const peer = hivewarddLockPeer(holder, role === 'holder' ? lockPath : null)
    const locality = hivewarddLockHolderLocality(peer, self, dataRootIsLocal, platform)
    return (
      locality === 'local' || (locality === 'unknown' && !!hooks.reclaimConfirmed?.(holder, role))
    )
  }
  const recoveryOwner: HivewarddLockRecoveryOwner = {
    record: serialized,
    exited: (ownerRecord) => {
      const owner = parseHivewarddInstanceLockRecord(ownerRecord)
      return Boolean(
        owner &&
        owner.identity === identity &&
        judgedHere(owner, 'recovery-owner') &&
        (!isAlive(owner.pid) || holderIdentity(owner) === 'differs')
      )
    }
  }

  const existingContents = readBoundedLockFile(lockPath)
  if (existingContents === null) {
    // Unreadable records cannot prove their holder exited.
    throw new HivewarddInstanceLockError(
      'hivewardd_instance_lock_unreadable',
      `The hivewardd instance lock at ${lockPath} is unreadable or larger than ` +
        `${MAX_HIVEWARDD_LOCK_BYTES} bytes. Refusing to reclaim it without proof that its holder ` +
        'has exited. Stop hivewardd and remove the stale lock manually.'
    )
  }
  const existing = parseHivewarddInstanceLockRecord(existingContents)
  if (!existing) {
    // Old torn writes become reclaimable only after the writer grace period.
    if (garbledLockIsAbandoned(lockPath)) {
      reclaimAndPublish(lockPath, dataRoot, existingContents, publish, recoveryOwner)
      return makeLock(lockPath, record)
    }
    throw new HivewarddInstanceLockError(
      'hivewardd_instance_lock_held',
      `The hivewardd instance lock at ${lockPath} is still being written by another process. Retry.`
    )
  }
  if (existing.identity !== identity) {
    throw new HivewarddInstanceLockError(
      'hivewardd_instance_lock_foreign_identity',
      `The hivewardd data root ${dataRoot} is locked by identity ${existing.identity} (pid ` +
        `${existing.pid}); this process runs as ${identity}. Two identities sharing one data ` +
        'root corrupts it. Give each its own HIVEWARD_USER_DATA.'
    )
  }
  const holder = hivewarddLockPeer(existing, lockPath)
  if (!judgedHere(existing, 'holder')) {
    // Foreign/unverifiable PIDs prove neither absence nor reuse here.
    throw hivewarddLockHolderUnverifiableError({
      holder: `${describeLockHolder(existing)} (pid ${existing.pid}, started ${existing.acquiredAt})`,
      foreign: hivewarddLockHolderLocality(holder, self, dataRootIsLocal, platform) === 'foreign',
      ...(hivewarddPeerIsLiveCloneMachine(holder, self, dataRootIsLocal, platform)
        ? { cloneMachine: { role: hooks.role ?? 'hivewardd' } }
        : {}),
      dataRoot,
      lockPath,
      hintRuntime:
        hooks.reclaimHintRuntime !== undefined
          ? hooks.reclaimHintRuntime
          : hooks.role === 'desktop'
            ? null
            : { execPath: process.execPath, entry: process.argv[1] }
    })
  }
  // Electron’s already-held lock proves other desktop instances absent despite PID reuse.
  const staleDesktopRecord = hooks.role === 'desktop' && existing.role === 'desktop'
  const verdict = staleDesktopRecord || !isAlive(existing.pid) ? null : holderIdentity(existing)
  if (verdict === 'unproven' && !existing.bootId) {
    throw possiblyReusedPidError(lockPath, existing, hooks.processName ?? readHivewarddProcessName)
  }
  if (verdict !== null && verdict !== 'differs') {
    throw new HivewarddInstanceLockError(
      'hivewardd_instance_lock_held',
      `${describeLockHolder(existing)} (pid ${existing.pid}, started ` +
        `${existing.acquiredAt || 'unknown'}) already owns the data root ${dataRoot}. Stop it ` +
        'before starting another, or use a different HIVEWARD_USER_DATA.'
    )
  }
  reclaimAndPublish(lockPath, dataRoot, existingContents, publish, recoveryOwner)
  return makeLock(lockPath, record)
}

function possiblyReusedPidError(
  lockPath: string,
  existing: HivewarddLockRecord,
  processName: (pid: number) => string | null
): HivewarddInstanceLockError {
  const name = processName(existing.pid)
  const holder = existing.role === 'desktop' ? 'the HiveWard desktop app' : 'hivewardd'
  return new HivewarddInstanceLockError(
    'hivewardd_instance_lock_held',
    `The hivewardd instance lock at ${lockPath} names pid ${existing.pid}, which is still running ` +
      `(as ${name ? `"${name}"` : 'an unknown program'}). This lock, written by ${holder} at ` +
      `${existing.acquiredAt}, does not record which boot it came from, so HiveWard cannot tell ` +
      `whether that process is still ${holder} or an unrelated program that reused the PID. ` +
      `If you are sure ${holder} is not running for this data root, delete ${lockPath} and ` +
      'try again, or use a different HIVEWARD_USER_DATA.'
  )
}

function garbledLockIsAbandoned(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > GARBLED_LOCK_GRACE_MS
  } catch {
    return false
  }
}

function describeLockHolder(record: HivewarddLockRecord): string {
  return record.role === 'desktop' ? 'The HiveWard desktop app' : 'Another hivewardd'
}

function makeLock(lockPath: string, record: HivewarddLockRecord): HivewarddInstanceLock {
  let released = false
  const stopHeartbeat = startHivewarddLockHeartbeat(lockPath)
  return {
    path: lockPath,
    record,
    release: () => {
      if (released) {
        return
      }
      released = true
      stopHeartbeat()
      // Re-read ownership before unlinking so a successor’s live runtime cannot be unlocked.
      const current = parseHivewarddInstanceLockRecord(readBoundedLockFile(lockPath) ?? '')
      if (!current || current.nonce !== record.nonce) {
        return
      }
      try {
        unlinkSync(lockPath)
      } catch {
        // Dead-PID leftovers can be reclaimed on the next start.
      }
    }
  }
}
