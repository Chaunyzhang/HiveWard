import { HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import type { HivewarddMigrationManifest } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { getDaemonHistoryDir } from '../../daemon/daemon-launch-paths'
import { getHistoryRoot } from '../../terminal-history-paths'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  findHivewarddMigrationImportReceipt,
  isHivewarddMigrationCommitDurable
} from './hivewardd-catalog-receipt-ledger'
import { installHivewarddMigrationReceivedBlobs } from './hivewardd-migration-blob-installers'
import { listHivewarddMigrationReceivedBlobNames } from './hivewardd-migration-blob-staging'
import type { HivewarddMigrationRequestIdentity } from './hivewardd-migration-staged-file'

type HivewarddMigrationBlobInstallRuntime = Pick<
  StoreRuntimeState,
  | 'state'
  | 'hivewarddMigrationBlobRoot'
  | 'hivewarddTerminalRestoreHints'
  | 'paneShellPath'
  | 'deferredShellHistoryWorktreeIds'
  | 'writeGeneration'
  | 'lastDurableWriteGeneration'
  | 'hivewarddMigrationCommitWriteGenerations'
>

type ClockOptions = { now?: () => Date }
type InstallOptions = ClockOptions & {
  /** Defer history installation while shells run in its worktree. */
  worktreeHasLiveShells?: (worktreeId: string) => boolean
}

const hivewarddMigrationBlobInstallContext = Symbol('HivewarddMigrationBlobInstallPersistence')
type HivewarddMigrationBlobInstallContext = {
  runtime: HivewarddMigrationBlobInstallRuntime
}

export class HivewarddMigrationBlobInstallPersistence {
  readonly [hivewarddMigrationBlobInstallContext]: HivewarddMigrationBlobInstallContext

  constructor(runtime: HivewarddMigrationBlobInstallRuntime) {
    this[hivewarddMigrationBlobInstallContext] = { runtime }
  }

  /** Wait for durable commit or a restart could lose both the catalog and its consumed blobs. */
  installHivewarddMigrationReceivedBlobs(
    manifest: HivewarddMigrationManifest,
    options: InstallOptions = {}
  ): void {
    const receipt = findHivewarddMigrationImportReceipt(
      this[hivewarddMigrationBlobInstallContext].runtime.state,
      manifest
    )
    if (receipt?.manifestSha256 !== manifest.manifestSha256) {
      return
    }
    installCommitted(this[hivewarddMigrationBlobInstallContext].runtime, manifest, options)
  }

  /** Recover interrupted installs; disk-loaded receipts already prove durability. */
  installPendingHivewarddMigrationReceivedBlobs(options: InstallOptions = {}): void {
    const { runtime } = this[hivewarddMigrationBlobInstallContext]
    for (const receipt of [
      ...(runtime.state.hivewarddMigrationImportReceipts ?? []),
      ...(runtime.state.hivewarddMigrationEvictedReceipts ?? [])
    ]) {
      try {
        installCommitted(runtime, receipt, options)
      } catch (error) {
        console.error(
          `[hivewardd-migration] installing received blobs for ${receipt.migrationId} failed:`,
          error
        )
      }
    }
  }

  /** Only the runtime installs pending shell history. */
  hasPendingHivewarddMigrationShellHistory(): boolean {
    const { runtime } = this[hivewarddMigrationBlobInstallContext]
    return [
      ...(runtime.state.hivewarddMigrationImportReceipts ?? []),
      ...(runtime.state.hivewarddMigrationEvictedReceipts ?? [])
    ].some((receipt) =>
      listHivewarddMigrationReceivedBlobNames(
        runtime.hivewarddMigrationBlobRoot,
        receipt,
        'shell-history'
      ).some((key) => HIVEWARDD_MIGRATION_BLOB_KIND_CONTRACTS['shell-history'].key.test(key))
    )
  }

  installDeferredHivewarddMigrationShellHistory(
    worktreeId: string,
    options: InstallOptions = {}
  ): void {
    const { runtime } = this[hivewarddMigrationBlobInstallContext]
    if (runtime.deferredShellHistoryWorktreeIds.has(worktreeId)) {
      this.installPendingHivewarddMigrationReceivedBlobs(options)
    }
  }

  /** Read without consuming. */
  peekHivewarddMigrationTerminalRestoreHint(
    paneKey: string,
    worktreeId: string,
    options: ClockOptions = {}
  ): string | null {
    return this[hivewarddMigrationBlobInstallContext].runtime.hivewarddTerminalRestoreHints.peek(
      paneKey,
      worktreeId,
      clock(options)
    )
  }

  /** Consume after spawn, even if it used a different cwd. */
  consumeHivewarddMigrationTerminalRestoreHint(paneKey: string, options: ClockOptions = {}): void {
    this[hivewarddMigrationBlobInstallContext].runtime.hivewarddTerminalRestoreHints.consume(
      paneKey,
      clock(options)
    )
  }
}

function installCommitted(
  runtime: HivewarddMigrationBlobInstallRuntime,
  migration: HivewarddMigrationRequestIdentity,
  options: InstallOptions
): void {
  if (!isHivewarddMigrationCommitDurable(runtime, migration)) {
    return
  }
  installHivewarddMigrationReceivedBlobs({
    migration,
    root: runtime.hivewarddMigrationBlobRoot,
    terminalRestoreHints: runtime.hivewarddTerminalRestoreHints,
    shellHistoryRoot: getHistoryRoot(),
    terminalHistoryRoot: getDaemonHistoryDir(),
    paneShellPath: () => runtime.paneShellPath(runtime.state.settings?.terminalDefaultShell),
    worktreeHasLiveShells: options.worktreeHasLiveShells,
    deferredShellHistoryWorktreeIds: runtime.deferredShellHistoryWorktreeIds,
    paneWorktreeId: (paneKey) => findPaneWorktreeId(runtime.state, paneKey),
    workspacePath: (worktreeId) => findWorkspacePath(runtime.state, worktreeId),
    now: clock(options)
  })
}

function clock(options: ClockOptions): number {
  return (options.now ?? (() => new Date()))().getTime()
}

// A git worktree id carries its path; a folder workspace's is on its record.
function findWorkspacePath(state: PersistedState, worktreeId: string): string | null {
  const separator = worktreeId.indexOf('::')
  if (separator > 0) {
    return worktreeId.slice(separator + 2) || null
  }
  return state.folderWorkspaces.find((folder) => folder.id === worktreeId)?.folderPath ?? null
}

// The commit merged the moved session in with its worktree ids unchanged.
function findPaneWorktreeId(state: PersistedState, paneKey: string): string | null {
  const tabId = parsePaneKey(paneKey)?.tabId
  if (!tabId) {
    return null
  }
  const sessions = [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})]
  for (const session of sessions) {
    for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
      if (tabs.some((tab) => tab.id === tabId)) {
        return worktreeId
      }
    }
  }
  return null
}
