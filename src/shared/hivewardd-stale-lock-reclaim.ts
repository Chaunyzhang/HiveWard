/** Explicit lock recovery for cases automatic startup cannot judge, such as shared-home reboot (#32177).
 * Dependency-free so clients, CLI and launcher share the command/result. */
import { quotePosixShellUnlessPlain } from './shell-argument-quoting'

export const HIVEWARDD_RECLAIM_STALE_LOCK_FLAG = '--reclaim-stale-lock'
export const HIVEWARDD_STALE_LOCK_DATA_ROOT_FLAG = '--data-root'
/** Pin confirmation to dry-run evidence. Clients probe this flag in bundles; reclaim alone cannot confirm safely. */
export const HIVEWARDD_STALE_LOCK_EXPECT_NONCE_FLAG = '--expect-nonce'

/** `--json` prints one of these; the exit code names the status too. */
export type HivewarddStaleLockReclaimStatus = 'none' | 'eligible' | 'refused' | 'reclaimed'

export type HivewarddStaleLockEvidence = {
  pid: number
  host: string
  bootId: string
  currentBootId: string
  ageMinutes: number
  /** The record's own nonce, for `--expect-nonce`; absent from builds before the pin. */
  nonce?: string
}

// Why `none` is not 0: a command pointed at the wrong data root must never read as a recovery.
export const HIVEWARDD_STALE_LOCK_RECLAIM_EXIT_CODES: Record<HivewarddStaleLockReclaimStatus, number> = {
  reclaimed: 0,
  refused: 1,
  eligible: 2,
  none: 4
}

/** Managed hosts lack hiveward/hivewardd on PATH, so pasteable hints must name the holder’s runtime, entry and data root. */
export type HivewarddReclaimHintRuntime = { execPath: string; entry: string | undefined }

export function hivewarddStaleLockReclaimCommand(
  dataRoot: string,
  runtime: HivewarddReclaimHintRuntime | null
): string {
  const program = runtime?.entry
    ? `${quotePosixShellUnlessPlain(runtime.execPath)} ${quotePosixShellUnlessPlain(runtime.entry)}`
    : 'hiveward serve'
  return `${program} ${HIVEWARDD_RECLAIM_STALE_LOCK_FLAG} ${HIVEWARDD_STALE_LOCK_DATA_ROOT_FLAG} ${quotePosixShellUnlessPlain(dataRoot)}`
}
