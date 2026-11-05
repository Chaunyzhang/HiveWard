import type {
  HivewarddMigrationCatalogAbortResult,
  HivewarddMigrationCatalogReference,
  HivewarddMigrationCatalogReferenceAbortResult,
  HivewarddMigrationCatalogState,
  HivewarddMigrationManifest
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type {
  HivewarddMigrationSnapshotChunkRequest,
  HivewarddMigrationSnapshotChunkResult
} from '../../shared/hivewardd-migration/hivewardd-migration-scrollback'
import type {
  HivewarddMigrationBlobChunkRequest,
  HivewarddMigrationBlobChunkResult,
  HivewarddMigrationBlobDescriptor
} from '../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import {
  abortStagedHivewarddMigrationCatalogByReferenceDurably,
  abortStagedHivewarddMigrationCatalogDurably,
  commitStagedHivewarddMigrationCatalogDurably,
  getHivewarddMigrationCatalogState,
  stageHivewarddMigrationCatalogDurably
} from './hivewardd-migration-catalog-import'
import { HiveWardRuntimeWithResolveWaiter } from './hiveward-runtime-resolve-waiter'
import type { WslMoveLiveTerminal } from '../persistence/moving-wsl-projects/wsl-move-gate-facts'
import type { RuntimeStore } from './runtime-store-contract'
import type { SessionReadTerminalScrollbackResult } from '../../shared/rpc-contract/session-terminal-scrollback-params'
import {
  readHostTerminalScrollback,
  type HostTerminalScrollbackReadRequest
} from './host-terminal-scrollback-read'

type MigrationStoreKey =
  | 'stageHivewarddMigrationCatalog'
  | 'commitStagedHivewarddMigrationCatalog'
  | 'stageHivewarddMigrationSnapshotChunk'
  | 'stageHivewarddMigrationBlobChunk'
  | 'abortStagedHivewarddMigrationCatalog'
  | 'abortStagedHivewarddMigrationCatalogByReference'
  | 'getHivewarddMigrationCatalogState'
  | 'flushPendingOrThrowAsync'

/** The destination half of a dormant catalog migration; every mutation is flushed before it answers. */
export abstract class HiveWardRuntimeWithMigrationCatalog extends HiveWardRuntimeWithResolveWaiter {
  async stageHivewarddMigrationCatalog(
    manifest: HivewarddMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<HivewarddMigrationCatalogState> {
    return stageHivewarddMigrationCatalogDurably({
      store: this.requireMigrationStore('stageHivewarddMigrationCatalog', 'flushPendingOrThrowAsync'),
      manifest,
      signal: options.signal
    })
  }

  async commitStagedHivewarddMigrationCatalog(
    manifest: HivewarddMigrationManifest,
    options: {
      signal?: AbortSignal
      expectedBlobs?: readonly HivewarddMigrationBlobDescriptor[]
    } = {}
  ): Promise<HivewarddMigrationCatalogState> {
    return commitStagedHivewarddMigrationCatalogDurably({
      store: this.requireMigrationStore(
        'commitStagedHivewarddMigrationCatalog',
        'flushPendingOrThrowAsync'
      ),
      manifest,
      signal: options.signal,
      expectedBlobs: options.expectedBlobs,
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells,
      onDurableCommit: () => {
        this.invalidateResolvedWorktreeCache()
        this.notifyReposChanged()
      }
    })
  }

  stageHivewarddMigrationSnapshotChunk(
    request: HivewarddMigrationSnapshotChunkRequest
  ): HivewarddMigrationSnapshotChunkResult {
    // SAFETY: The virtual Store may differ from the checked Store; preserve its native failure.
    return this.requireMigrationStore('stageHivewarddMigrationSnapshotChunk')
      .stageHivewarddMigrationSnapshotChunk!(request)
  }

  stageHivewarddMigrationBlobChunk(
    request: HivewarddMigrationBlobChunkRequest
  ): HivewarddMigrationBlobChunkResult {
    // SAFETY: The virtual Store may differ from the checked Store; preserve its native failure.
    return this.requireMigrationStore('stageHivewarddMigrationBlobChunk').stageHivewarddMigrationBlobChunk!(
      request
    )
  }

  async abortStagedHivewarddMigrationCatalog(
    manifest: HivewarddMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<HivewarddMigrationCatalogAbortResult> {
    return abortStagedHivewarddMigrationCatalogDurably({
      store: this.requireMigrationStore(
        'abortStagedHivewarddMigrationCatalog',
        'flushPendingOrThrowAsync'
      ),
      manifest,
      signal: options.signal
    })
  }

  async abortStagedHivewarddMigrationCatalogByReference(
    reference: HivewarddMigrationCatalogReference,
    options: { signal?: AbortSignal } = {}
  ): Promise<HivewarddMigrationCatalogReferenceAbortResult> {
    return abortStagedHivewarddMigrationCatalogByReferenceDurably({
      store: this.requireMigrationStore(
        'abortStagedHivewarddMigrationCatalogByReference',
        'flushPendingOrThrowAsync'
      ),
      reference,
      signal: options.signal
    })
  }

  getHivewarddMigrationCatalogState(manifest: HivewarddMigrationManifest): HivewarddMigrationCatalogState {
    return getHivewarddMigrationCatalogState({
      store: this.requireMigrationStore('getHivewarddMigrationCatalogState'),
      manifest,
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
    })
  }

  /** Install deferred migrated history after host-shell discovery; unanswered inventory retries on the next catalog query. */
  async installPendingHivewarddMigrationShellHistory(): Promise<void> {
    const store = this.store
    // Every daemon start calls this; no pending blobs must cost no inventory.
    if (
      !store?.installPendingHivewarddMigrationReceivedBlobs ||
      !store.hasPendingHivewarddMigrationShellHistory?.()
    ) {
      return
    }
    // Inventory first to find restart-surviving shells; real worktrees preserve their restored orchestration receipts.
    if (
      this.ptyController?.listProcesses &&
      !(await this.refreshPtyWorktreeRecordsWithControllerInventory([
        ...(await this.getResolvedWorktreeMap()).values()
      ]))
    ) {
      console.warn('[hivewardd-migration] shell history waits: the terminal inventory did not answer')
      return
    }
    store.installPendingHivewarddMigrationReceivedBlobs({
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
    })
  }

  override onPtyExit(
    ...args: Parameters<HiveWardRuntimeWithResolveWaiter['onPtyExit']>
  ): ReturnType<HiveWardRuntimeWithResolveWaiter['onPtyExit']> {
    const worktreeId = this.ptysById.get(args[0])?.worktreeId
    const result = super.onPtyExit(...args)
    if (worktreeId) {
      try {
        this.store?.installDeferredHivewarddMigrationShellHistory?.(worktreeId, {
          worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
        })
      } catch (error) {
        console.error('[hivewardd-migration] installing deferred shell history failed:', error)
      }
    }
    return result
  }

  // Migrated history belongs here; same-id SSH twins never write it.
  private readonly migrationWorktreeHasLiveShells = (worktreeId: string): boolean =>
    this.getLivePtyIdsForWorktree(worktreeId, undefined, { resolvedConnectionId: null }).size > 0

  /** A migrated pane's stored scrollback, for a client whose own copy is gone or never existed. */
  async readTerminalScrollbackForClient(
    request: HostTerminalScrollbackReadRequest
  ): Promise<SessionReadTerminalScrollbackResult> {
    const store = this.store
    const readSnapshot = store?.readTerminalScrollbackSnapshotAsync
    const statSnapshotSize = store?.statTerminalScrollbackSnapshotSize
    if (!store || !readSnapshot || !statSnapshotSize) {
      throw new Error('runtime_unavailable')
    }
    return readHostTerminalScrollback(
      {
        resolveWorktreeId: async (selector) => (await this.resolveWorkspaceSelector(selector)).id,
        getWorkspaceSession: (worktreeId) => this.workspaceSessions.get(worktreeId),
        statSnapshotSize: (ref) => statSnapshotSize.call(store, ref),
        readSnapshot: (ref) => readSnapshot.call(store, ref)
      },
      request
    )
  }

  /** The pane a live terminal shows, including one the window has not reopened since a relaunch. */
  wslMovePaneKeyForPty(ptyId: string): string | null {
    const pty = this.ptysById.get(ptyId)
    return pty ? this.paneOfPty(pty).paneKey : null
  }

  /** This desktop's live terminals in the workspaces, for a WSL move's gate and pause. */
  listWslMoveLiveTerminals(workspaceIds: readonly string[]): WslMoveLiveTerminal[] {
    const terminals = new Map<string, WslMoveLiveTerminal>()
    for (const workspaceId of workspaceIds) {
      // Local only: a same-id SSH twin's terminals are another host's.
      for (const ptyId of this.getLivePtyIdsForWorktree(workspaceId, undefined, {
        resolvedConnectionId: null
      })) {
        const pty = this.ptysById.get(ptyId)
        terminals.set(ptyId, {
          ptyId,
          workspaceId,
          paneKey: pty ? this.paneOfPty(pty).paneKey : null,
          wslDistro: pty?.wslDistro ?? null,
          foregroundAgent: pty?.foregroundAgent ?? null
        })
      }
    }
    return [...terminals.values()]
  }

  // Check the captured Store, not a potentially different virtual return.
  private requireMigrationStore(...methods: MigrationStoreKey[]): RuntimeStore {
    const store = this.store
    if (!store || methods.some((method) => typeof store[method] !== 'function')) {
      throw new Error('runtime_unavailable')
    }
    return this.requireStore()
  }
}
