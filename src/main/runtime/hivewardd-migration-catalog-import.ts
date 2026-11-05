import type {
  HivewarddMigrationCatalogAbortResult,
  HivewarddMigrationCatalogReference,
  HivewarddMigrationCatalogReferenceAbortResult,
  HivewarddMigrationCatalogState,
  HivewarddMigrationManifest
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { HivewarddMigrationBlobDescriptor } from '../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import type { Store } from '../persistence/loading-store/store'

/** A moved history waits while a shell runs in its worktree: that shell would overwrite it. */
type WorktreeHasLiveShells = (worktreeId: string) => boolean

type HivewarddMigrationCatalogFlushStore = Partial<Pick<Store, 'flushPendingOrThrowAsync'>>
type HivewarddMigrationCatalogStageStore = HivewarddMigrationCatalogFlushStore &
  Partial<Pick<Store, 'stageHivewarddMigrationCatalog'>>
type HivewarddMigrationCatalogCommitStore = HivewarddMigrationCatalogFlushStore &
  Partial<Pick<Store, 'commitStagedHivewarddMigrationCatalog' | 'installHivewarddMigrationReceivedBlobs'>>
type HivewarddMigrationCatalogAbortStore = HivewarddMigrationCatalogFlushStore &
  Partial<Pick<Store, 'abortStagedHivewarddMigrationCatalog'>>
type HivewarddMigrationCatalogAbortByReferenceStore = HivewarddMigrationCatalogFlushStore &
  Partial<Pick<Store, 'abortStagedHivewarddMigrationCatalogByReference'>>

export async function stageHivewarddMigrationCatalogDurably(args: {
  store: HivewarddMigrationCatalogStageStore
  manifest: HivewarddMigrationManifest
  signal?: AbortSignal
}): Promise<HivewarddMigrationCatalogState> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.stageHivewarddMigrationCatalog!(args.manifest)
  await flushMigrationState(args.store, args.signal)
  return result
}

export async function commitStagedHivewarddMigrationCatalogDurably(args: {
  store: HivewarddMigrationCatalogCommitStore
  manifest: HivewarddMigrationManifest
  signal?: AbortSignal
  expectedBlobs?: readonly HivewarddMigrationBlobDescriptor[]
  onDurableCommit: () => void
  worktreeHasLiveShells?: WorktreeHasLiveShells
}): Promise<HivewarddMigrationCatalogState> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.commitStagedHivewarddMigrationCatalog!(
    args.manifest,
    args.expectedBlobs ? { expectedBlobs: args.expectedBlobs } : {}
  )
  await flushMigrationState(args.store, args.signal)
  args.onDurableCommit()
  installReceivedBlobs(args.store, args.manifest, args.worktreeHasLiveShells)
  return result
}

/** After the durable commit, on its retries and state queries; the store load retries too. */
function installReceivedBlobs(
  store: Partial<Pick<Store, 'installHivewarddMigrationReceivedBlobs'>>,
  manifest: HivewarddMigrationManifest,
  worktreeHasLiveShells: WorktreeHasLiveShells | undefined
): void {
  try {
    store.installHivewarddMigrationReceivedBlobs?.(manifest, { worktreeHasLiveShells })
  } catch (error) {
    // The catalog is committed; a failed install keeps its blob for the next retry.
    console.error('[hivewardd-migration] installing received blobs failed:', error)
  }
}

export async function abortStagedHivewarddMigrationCatalogDurably(args: {
  store: HivewarddMigrationCatalogAbortStore
  manifest: HivewarddMigrationManifest
  signal?: AbortSignal
}): Promise<HivewarddMigrationCatalogAbortResult> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.abortStagedHivewarddMigrationCatalog!(args.manifest)
  // An already-absent retry may follow an in-memory abort whose flush failed.
  if (result.state === 'absent') {
    await flushMigrationState(args.store, args.signal)
    return { ...result, durableAbsent: true }
  }
  return result
}

export async function abortStagedHivewarddMigrationCatalogByReferenceDurably(args: {
  store: HivewarddMigrationCatalogAbortByReferenceStore
  reference: HivewarddMigrationCatalogReference
  signal?: AbortSignal
}): Promise<HivewarddMigrationCatalogReferenceAbortResult> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.abortStagedHivewarddMigrationCatalogByReference!(args.reference)
  await flushMigrationState(args.store, args.signal)
  // Either answer is flushed first, so a source that cannot re-send the manifest may act on it.
  return result.state === 'absent'
    ? { ...result, durableAbsent: true }
    : { ...result, durableCommitted: true }
}

export function getHivewarddMigrationCatalogState(args: {
  store: Partial<
    Pick<Store, 'getHivewarddMigrationCatalogState' | 'installHivewarddMigrationReceivedBlobs'>
  >
  manifest: HivewarddMigrationManifest
  worktreeHasLiveShells?: WorktreeHasLiveShells
}): HivewarddMigrationCatalogState {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.getHivewarddMigrationCatalogState!(args.manifest)
  if (result.state === 'committed') {
    installReceivedBlobs(args.store, args.manifest, args.worktreeHasLiveShells)
  }
  return result
}

function flushMigrationState(
  store: HivewarddMigrationCatalogFlushStore,
  signal?: AbortSignal
): Promise<void> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  return store.flushPendingOrThrowAsync!({
    signal,
    drainToStableGeneration: false
  })
}
