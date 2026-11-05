// The JSON header carries the unhashed worktree ID needed for history GC; raw history follows.
import { z } from 'zod'
import { HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import { hashWorktreeId } from '../../terminal-history-id'

// fish history lives outside HiveWard's store and cannot migrate.
export const HIVEWARDD_MIGRATION_SHELL_HISTORY_SHELLS = ['zsh', 'bash'] as const

export type HivewarddMigrationShellHistoryShell = (typeof HIVEWARDD_MIGRATION_SHELL_HISTORY_SHELLS)[number]

export const HIVEWARDD_MIGRATION_SHELL_HISTORY_VERSION = 1
/** Bound header scanning; worktree IDs contain a repo ID and path. */
export const HIVEWARDD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES = 16 * 1024
const NEWLINE = 0x0a

const HeaderSchema = z.object({
  version: z.literal(HIVEWARDD_MIGRATION_SHELL_HISTORY_VERSION),
  worktreeId: z.string().min(1),
  loginShell: z.literal(true).optional()
})

export const MAX_HIVEWARDD_MIGRATION_SHELL_HISTORY_BYTES =
  HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS['shell-history'].maxBytes

export type HivewarddMigrationShellHistoryKey = {
  worktreeHash: string
  shell: HivewarddMigrationShellHistoryShell
}

export type HivewarddMigrationShellHistoryHeader = {
  worktreeId: string
  /** WSL bridge history uses bash_history for the distro login shell when no zsh sibling exists. */
  loginShell: boolean
  byteLength: number
}

export function hivewarddMigrationShellHistoryKey(
  worktreeId: string,
  shell: HivewarddMigrationShellHistoryShell
): string {
  return `${hashWorktreeId(worktreeId)}-${shell}`
}

export function shellHistoryFileName(shell: HivewarddMigrationShellHistoryShell): string {
  return `${shell}_history`
}

export function parseHivewarddMigrationShellHistoryKey(key: string): HivewarddMigrationShellHistoryKey {
  if (!HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS['shell-history'].key.test(key)) {
    throw new Error('hivewardd_migration_shell_history_key_invalid')
  }
  const [worktreeHash, shell] = key.split('-')
  const supported = HIVEWARDD_MIGRATION_SHELL_HISTORY_SHELLS.find((entry) => entry === shell)
  if (!supported) {
    throw new Error('hivewardd_migration_shell_history_shell_unsupported')
  }
  return { worktreeHash, shell: supported }
}

export function encodeHivewarddMigrationShellHistoryHeader(
  worktreeId: string,
  options: { loginShell?: boolean } = {}
): Buffer {
  const document = {
    version: HIVEWARDD_MIGRATION_SHELL_HISTORY_VERSION,
    worktreeId,
    ...(options.loginShell ? { loginShell: true } : {})
  }
  const header = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8')
  if (header.length > HIVEWARDD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES) {
    throw new Error('hivewardd_migration_shell_history_worktree_id_too_long')
  }
  return header
}

/** Verify the header matches the hashed key; totalBytes includes the header and must leave history bytes. */
export function parseHivewarddMigrationShellHistoryHeader(
  key: string,
  head: Buffer,
  totalBytes: number
): HivewarddMigrationShellHistoryHeader {
  const parsedKey = parseHivewarddMigrationShellHistoryKey(key)
  const end = head.subarray(0, HIVEWARDD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES).indexOf(NEWLINE)
  if (end === -1) {
    throw new Error('hivewardd_migration_shell_history_header_invalid')
  }
  const { worktreeId, loginShell } = parseHeaderLine(head.subarray(0, end))
  if (hashWorktreeId(worktreeId) !== parsedKey.worktreeHash) {
    throw new Error('hivewardd_migration_shell_history_key_mismatch')
  }
  const byteLength = end + 1
  if (totalBytes <= byteLength) {
    throw new Error('hivewardd_migration_shell_history_empty')
  }
  return { worktreeId, loginShell, byteLength }
}

function parseHeaderLine(line: Buffer): { worktreeId: string; loginShell: boolean } {
  try {
    const parsed = HeaderSchema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
    )
    if (parsed.success) {
      return { worktreeId: parsed.data.worktreeId, loginShell: parsed.data.loginShell === true }
    }
  } catch {
    // Not UTF-8 JSON; refused below like any other malformed header.
  }
  throw new Error('hivewardd_migration_shell_history_header_invalid')
}
