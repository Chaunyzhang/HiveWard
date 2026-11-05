// Validate blob contents before commit; install only advertised kinds after durable commit.
import { servesWslMovedPaneHistory } from '../../hivewardd/hivewardd-migration-wsl-destination'
import { readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HivewarddMigrationBlobKind } from '../../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import type { HivewarddMigrationManifest } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import {
  HIVEWARDD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY,
  parseHivewarddMigrationTerminalRestoreHintsText,
  type HivewarddMigrationTerminalRestoreHint
} from '../../../shared/hivewardd-migration/hivewardd-migration-terminal-restore-hints'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  getHivewarddMigrationReceivedBlobPath,
  stagedHivewarddMigrationBlobFiles
} from './hivewardd-migration-blob-staging'
import {
  hivewarddMigrationStagingKey,
  type HivewarddMigrationRequestIdentity
} from './hivewardd-migration-staged-file'
import {
  assertHivewarddMigrationShellHistoryValid,
  installHivewarddMigrationShellHistory
} from './hivewardd-shell-history-installer'
import {
  assertHivewarddMigrationTerminalHistoryValid,
  installHivewarddMigrationTerminalHistory
} from './hivewardd-terminal-history-installer'
import type {
  HivewarddTerminalRestoreHintPlacement,
  HivewarddTerminalRestoreHintStore
} from './hivewardd-terminal-restore-hint-store'

type HivewarddMigrationStagedBlobFile = {
  key: string
  path: string
  manifest: HivewarddMigrationManifest
}

type HivewarddMigrationBlobContentCheck = (file: HivewarddMigrationStagedBlobFile) => void

const UTF8 = new TextDecoder('utf-8', { fatal: true })

const BLOB_CONTENT_CHECKS: Partial<Record<HivewarddMigrationBlobKind, HivewarddMigrationBlobContentCheck>> =
  {
    'terminal-restore-hints': ({ path }) => {
      parseHivewarddMigrationTerminalRestoreHintsText(decodeUtf8(readFileSync(path)))
    },
    'shell-history': ({ key, path, manifest }) => {
      assertHivewarddMigrationShellHistoryValid(key, path, manifest.payload)
    },
    'terminal-history': ({ key, path, manifest }) => {
      assertHivewarddMigrationTerminalHistoryValid(key, path, manifest)
    }
  }

/** Reject malformed content before commit while the source still owns everything. */
export function assertHivewarddMigrationBlobContentsValid(
  manifest: HivewarddMigrationManifest,
  root: string
): void {
  for (const { descriptor, path } of stagedHivewarddMigrationBlobFiles(manifest, root)) {
    const check = BLOB_CONTENT_CHECKS[descriptor.blobKind]
    if (!check) {
      continue
    }
    try {
      check({ key: descriptor.key, path, manifest })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`hivewardd_migration_blob_content_invalid:${descriptor.blobKind}:${reason}`)
    }
  }
}

export type HivewarddMigrationBlobInstall = {
  migration: HivewarddMigrationRequestIdentity
  root: string
  terminalRestoreHints: HivewarddTerminalRestoreHintStore
  /** This host's getHistoryRoot(). */
  shellHistoryRoot: string
  /** This host's `getDaemonHistoryDir()`, where its terminals' checkpoints live. */
  terminalHistoryRoot: string
  /** The shell binary a new pane on this host would actually run. */
  paneShellPath: () => string
  /** Defer without runtime evidence: shells surviving a restart could overwrite installed history. */
  worktreeHasLiveShells?: (worktreeId: string) => boolean
  deferredShellHistoryWorktreeIds: Set<string>
  paneWorktreeId: (paneKey: string) => string | null
  /** The workspace's folder on this host, or null when it is not here. */
  workspacePath: (worktreeId: string) => string | null
  now: number
}

/** Retain failed blobs for retry; installed-migration markers prevent consumed hints from reviving. */
export function installHivewarddMigrationReceivedBlobs(install: HivewarddMigrationBlobInstall): void {
  let firstError: unknown = null
  // Keep failures independent so other blob kinds can still install.
  for (const installKind of [
    installTerminalRestoreHints,
    installShellHistory,
    installTerminalHistory
  ]) {
    try {
      installKind(install)
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== null) {
    throw firstError
  }
}

function installTerminalHistory(install: HivewarddMigrationBlobInstall): void {
  // Only a WSL host advertises terminal history, so no other destination should hold any.
  if (!servesWslMovedPaneHistory()) {
    return
  }
  installHivewarddMigrationTerminalHistory({
    migration: install.migration,
    root: install.root,
    historyRoot: install.terminalHistoryRoot,
    paneWorktreeId: install.paneWorktreeId,
    workspacePath: install.workspacePath,
    now: install.now
  })
}

function installShellHistory(install: HivewarddMigrationBlobInstall): void {
  if (!install.worktreeHasLiveShells) {
    return
  }
  installHivewarddMigrationShellHistory({
    migration: install.migration,
    root: install.root,
    historyRoot: install.shellHistoryRoot,
    paneShellPath: install.paneShellPath,
    worktreeHasLiveShells: install.worktreeHasLiveShells,
    deferredWorktreeIds: install.deferredShellHistoryWorktreeIds,
    now: install.now
  })
}

function installTerminalRestoreHints(install: HivewarddMigrationBlobInstall): void {
  const path = getHivewarddMigrationReceivedBlobPath(install.root, install.migration, {
    blobKind: 'terminal-restore-hints',
    key: HIVEWARDD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY
  })
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return
  }
  const migrationKey = hivewarddMigrationStagingKey(install.migration)
  if (!install.terminalRestoreHints.hasInstalledMigration(migrationKey)) {
    try {
      const document = parseHivewarddMigrationTerminalRestoreHintsText(decodeUtf8(bytes))
      install.terminalRestoreHints.install(
        { migrationKey, migrationId: install.migration.migrationId },
        placeHints(document.hints, install.paneWorktreeId),
        install.now
      )
    } catch (error) {
      if (!isHintFormatError(error)) {
        throw error
      }
      // Pre-commit validation passed; damaged hints can only fall back to the default folder now.
      console.error(
        `[hivewardd-migration] dropped unreadable terminal restore hints for ${install.migration.migrationId}:`,
        error
      )
    }
  }
  rmSync(path, { force: true })
  syncDirectoryDurablySync(dirname(path))
}

// Drop hints whose panes have no worktree on this host.
function placeHints(
  hints: readonly HivewarddMigrationTerminalRestoreHint[],
  paneWorktreeId: (paneKey: string) => string | null
): HivewarddTerminalRestoreHintPlacement[] {
  return hints.flatMap((hint) => {
    const worktreeId = paneWorktreeId(hint.paneKey)
    return worktreeId ? [{ ...hint, worktreeId }] : []
  })
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes)
  } catch {
    throw new Error('hivewardd_migration_terminal_restore_hints_not_utf8')
  }
}

function isHintFormatError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('hivewardd_migration_terminal_restore_')
}
