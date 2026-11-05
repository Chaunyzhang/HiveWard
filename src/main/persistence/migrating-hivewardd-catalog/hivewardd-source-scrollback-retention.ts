import type { HivewarddMigrationManifest } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  readTerminalScrollbackStoredBytesSync,
  writeTerminalScrollbackSnapshotSync
} from '../../terminal-scrollback-snapshots'
import { deleteUnreferencedHivewarddMigrationScrollback } from './hivewardd-source-scrollback-cleanup'
import {
  findSnapshotBytes,
  matchesHivewarddMigrationSnapshotBytes
} from './hivewardd-source-scrollback-state'

type RetentionRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage' | 'retainedScrollbackRefsByMigrationId'
>

/** Persist signed snapshots until commit/abandonment so tab closes cannot break transfer retries. */
export function syncHivewarddMigrationScrollbackRetention(
  runtime: RetentionRuntime,
  pending: readonly HivewarddMigrationManifest[]
): void {
  const held = runtime.retainedScrollbackRefsByMigrationId
  const pendingIds = new Set(pending.map((manifest) => manifest.migrationId))
  const released = [...held].filter(([migrationId]) => !pendingIds.has(migrationId))
  for (const manifest of pending) {
    if (held.has(manifest.migrationId)) {
      continue
    }
    const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
    for (const descriptor of snapshots) {
      persistInlineSnapshot(runtime, descriptor)
    }
    held.set(manifest.migrationId, new Set(snapshots.map((snapshot) => snapshot.ref)))
  }
  for (const [migrationId] of released) {
    held.delete(migrationId)
  }
  deleteUnreferencedHivewarddMigrationScrollback(
    runtime,
    released.flatMap(([, refs]) => [...refs])
  )
}

function persistInlineSnapshot(
  runtime: RetentionRuntime,
  descriptor: NonNullable<
    NonNullable<HivewarddMigrationManifest['payload']['dormantState']>['terminalScrollbackSnapshots']
  >[number]
): void {
  const storage = runtime.terminalScrollbackSnapshotStorage
  // A newer inline copy (local-only park) can supersede a file under the same ref; keep what was signed.
  const stored = readTerminalScrollbackStoredBytesSync(descriptor.ref, storage)
  if (matchesHivewarddMigrationSnapshotBytes(stored, descriptor)) {
    return
  }
  const bytes = findSnapshotBytes(runtime.state, descriptor, storage)
  if (bytes) {
    writeTerminalScrollbackSnapshotSync({
      tabId: descriptor.tabId,
      leafId: descriptor.leafId,
      buffer: bytes.toString('utf8'),
      storage
    })
  }
}
