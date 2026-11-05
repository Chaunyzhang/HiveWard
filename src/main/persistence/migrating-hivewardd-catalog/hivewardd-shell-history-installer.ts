// Validate histories before catalog commit; install into this host's HISTFILE paths afterward.
import { createHash } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import type { HivewarddMigrationManifest } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import { projectGroupIdFromRepoId } from '../../../shared/folder-workspace-worktree'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree/id'
import {
  durableWriteTempPath,
  syncDirectoryDurablySync,
  writeFileDurableSync
} from '../../durable-file-write'
import { resolveUnixPaneShellPath } from '../../daemon/shell-ready'
import { resolveUnixShellPath } from '../../providers/local-pty/local-pty-executable-spawn'
import { readHistoryMeta, resolveShellKind } from '../../terminal-history'
import {
  getHivewarddMigrationReceivedBlobPath,
  listHivewarddMigrationReceivedBlobNames
} from './hivewardd-migration-blob-staging'
import {
  HIVEWARDD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES,
  parseHivewarddMigrationShellHistoryHeader,
  parseHivewarddMigrationShellHistoryKey,
  shellHistoryFileName,
  type HivewarddMigrationShellHistoryShell
} from './hivewardd-migration-shell-history-format'
import type { HivewarddMigrationRequestIdentity } from './hivewardd-migration-staged-file'

type ShellHistoryCatalog = Pick<
  HivewarddMigrationManifest['payload'],
  'repositories' | 'projectGroups' | 'folderWorkspaces'
>

export function assertHivewarddMigrationShellHistoryValid(
  key: string,
  path: string,
  catalog: ShellHistoryCatalog
): void {
  const { worktreeId } = parseHivewarddMigrationShellHistoryHeader(
    key,
    readHead(path, HIVEWARDD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES),
    statSync(path).size
  )
  // Refuse foreign-worktree history before commit to avoid silently losing it.
  if (!catalogOwnsWorktree(catalog, worktreeId)) {
    throw new Error('hivewardd_migration_shell_history_worktree_not_migrated')
  }
}

export type HivewarddShellHistoryInstall = {
  migration: HivewarddMigrationRequestIdentity
  root: string
  /** This host's getHistoryRoot(). */
  historyRoot: string
  /** Resolve as a new pane would; see resolveNewPaneShellPath. */
  paneShellPath: () => string
  worktreeHasLiveShells: (worktreeId: string) => boolean
  deferredWorktreeIds: Set<string>
  now: number
}

/** Defer live-shell histories to avoid exit-time overwrite; retain failed blobs and retry other files. */
export function installHivewarddMigrationShellHistory(install: HivewarddShellHistoryInstall): void {
  let firstError: unknown = null
  for (const key of listHivewarddMigrationReceivedBlobNames(
    install.root,
    install.migration,
    'shell-history'
  )) {
    if (!HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS['shell-history'].key.test(key)) {
      continue
    }
    try {
      installOne(install, key)
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== null) {
    throw firstError
  }
}

type ReceivedShellHistory = {
  worktreeId: string
  worktreeHash: string
  shell: HivewarddMigrationShellHistoryShell
  sha256: string
  history: Buffer
}

function installOne(install: HivewarddShellHistoryInstall, key: string): void {
  const path = getHivewarddMigrationReceivedBlobPath(install.root, install.migration, {
    blobKind: 'shell-history',
    key
  })
  const bytes = readFileSync(path)
  let moved: ReceivedShellHistory
  try {
    const header = parseHivewarddMigrationShellHistoryHeader(key, bytes, bytes.length)
    const { worktreeHash, shell } = parseHivewarddMigrationShellHistoryKey(key)
    moved = {
      worktreeId: header.worktreeId,
      worktreeHash,
      shell: header.loginShell ? (paneHistoryShell(install.paneShellPath) ?? shell) : shell,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      history: withFinalNewline(bytes.subarray(header.byteLength))
    }
  } catch (error) {
    // Pre-commit validation passed, so these received bytes were damaged afterward.
    console.error(`[hivewardd-migration] dropped unreadable shell history ${key}:`, error)
    removeReceived(path)
    return
  }
  const directory = join(install.historyRoot, moved.worktreeHash)
  const meta = readHistoryMeta(directory)
  // Hash-only markers prevent reinstallation if the pane shell changes between retries.
  if (meta?.installedMigrationBlobs?.some((blob) => blob.sha256 === moved.sha256)) {
    removeReceived(path)
    return
  }
  if (install.worktreeHasLiveShells(moved.worktreeId)) {
    install.deferredWorktreeIds.add(moved.worktreeId)
    return
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeHistoryFile(join(directory, shellHistoryFileName(moved.shell)), moved.history)
  writeMeta(directory, moved, install.now)
  removeReceived(path)
  install.deferredWorktreeIds.delete(moved.worktreeId)
}

// A history without a final newline would run its last command into the host's next one.
function withFinalNewline(history: Buffer): Buffer {
  return history.at(-1) === 0x0a ? history : Buffer.concat([history, Buffer.from('\n')])
}

// Prepend older moved history so this host's newest commands remain last.
function writeHistoryFile(path: string, moved: Buffer): void {
  const existing = readExisting(path)
  // A crash between this write and the meta.json marker leaves the moved bytes already in front.
  if (existing?.subarray(0, moved.length).equals(moved)) {
    return
  }
  const content = existing ? Buffer.concat([moved, existing]) : moved
  const target = writeTarget(path)
  writeFileDurableSync(durableWriteTempPath(target), target, content, 0o600)
}

// A symlinked HISTFILE is written through to its target so the link the user set up survives.
function writeTarget(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }
  }
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path
  } catch (error) {
    if (isMissing(error)) {
      return path
    }
    throw error
  }
}

// GC prunes a history directory by its meta.json worktree id, so it must name the host's id.
function writeMeta(directory: string, moved: ReceivedShellHistory, now: number): void {
  const existing = readHistoryMeta(directory)
  const path = join(directory, 'meta.json')
  const meta = {
    ...existing,
    worktreeId: moved.worktreeId,
    createdAt: existing?.createdAt ?? new Date(now).toISOString(),
    installedMigrationBlobs: [
      ...(existing?.installedMigrationBlobs ?? []),
      { sha256: moved.sha256, shell: moved.shell }
    ]
  }
  writeFileDurableSync(durableWriteTempPath(path), path, JSON.stringify(meta), 0o600)
}

/** Map login history to the pane's bash/zsh shell; null lets the caller preserve the source format. */
function paneHistoryShell(paneShellPath: () => string): HivewarddMigrationShellHistoryShell | null {
  const kind = resolveShellKind(paneShellPath())
  return kind === 'zsh' || kind === 'bash' ? kind : null
}

/** Resolve like pane spawn: host setting, SHELL, then executable fallback. */
export function resolveNewPaneShellPath(defaultShell: string | undefined): string {
  try {
    return resolveUnixShellPath(resolveUnixPaneShellPath({}, undefined, defaultShell))
  } catch {
    return ''
  }
}

function readExisting(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function removeReceived(path: string): void {
  rmSync(path, { force: true })
  syncDirectoryDurablySync(dirname(path))
}

function readHead(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

function catalogOwnsWorktree(catalog: ShellHistoryCatalog, worktreeId: string): boolean {
  if (
    catalog.folderWorkspaces.some((workspace) => folderWorkspaceKey(workspace.id) === worktreeId)
  ) {
    return true
  }
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed?.repoId || !parsed.worktreePath) {
    return false
  }
  const projectGroupId = projectGroupIdFromRepoId(parsed.repoId)
  return projectGroupId
    ? catalog.projectGroups.some((group) => group.id === projectGroupId)
    : catalog.repositories.some((repo) => repo.id === parsed.repoId)
}
