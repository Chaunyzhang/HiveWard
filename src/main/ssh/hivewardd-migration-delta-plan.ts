/** Subtract earlier migrations' currently retained rows/state; export only additions. Never merge overlapping old source copies over server-owned state. */
import type { HivewarddDeltaMovePreview, HivewarddDeltaMoveRow } from '../../shared/hivewardd-managed-runtime'
import type {
  HivewarddMigrationCatalogPayload,
  HivewarddMigrationManifest
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import { isRetainedHivewarddMigrationSourceCutover } from '../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import type { HivewarddMigrationSourceCutover } from '../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence/loading-store/store'
import { collectHivewarddMigrationSourceCatalog } from '../persistence/migrating-hivewardd-catalog/hivewardd-source-catalog'
import { listHivewarddMigrationCutoverChainForTarget } from './hivewardd-migration-cutover-journal'
import {
  createHivewarddMigrationManifest,
  hivewarddMigrationCatalogIds,
  type HivewarddMigrationCatalogIds
} from './hivewardd-migration-manifest-export'
import type { HivewarddMigrationSnapshotSource } from './hivewardd-migration-snapshot-coordinator'
import { collectUntransferredDependentBlockers } from './targets/ssh-target-hivewardd-dependents'
import type { HivewarddMigrationPreflightStore } from './targets/ssh-target-hivewardd-preflight'

export type HivewarddDeltaSourceStore = HivewarddMigrationPreflightStore & HivewarddMigrationSnapshotSource

export function unfinishedHivewarddDelta(
  chain: readonly HivewarddMigrationSourceCutover[]
): HivewarddMigrationSourceCutover | null {
  const head = chain.at(-1)
  return head?.supersedesMigrationId &&
    head.phase !== 'source-retired' &&
    !isRetainedHivewarddMigrationSourceCutover(head)
    ? head
    : null
}

export function committedHivewarddMigrationChain(
  chain: readonly HivewarddMigrationSourceCutover[]
): HivewarddMigrationSourceCutover[] {
  return (unfinishedHivewarddDelta(chain) ? chain.slice(0, -1) : chain).filter(
    (cutover) => cutover.phase === 'destination-committed' || cutover.phase === 'source-retired'
  )
}

export function hivewarddDeltaSourceStore(
  store: Store,
  target: SshTarget,
  moved: readonly HivewarddMigrationSourceCutover[],
  /** Older interrupted deltas may still include server-owned groups. */
  journaled?: HivewarddMigrationManifest
): HivewarddDeltaSourceStore {
  const ids = hivewarddMigrationCatalogIds(moved.map((cutover) => cutover.manifest.payload))
  // Never move projects/groups already owned through earlier links.
  const linked = moved.flatMap((cutover) => cutover.linkedRepositoryIds ?? [])
  const linkedGroups = moved.flatMap((cutover) => cutover.linkedProjectGroupIds ?? [])
  const linkedFolders = moved.flatMap((cutover) => cutover.linkedFolderWorkspaceIds ?? [])
  // New rows reference server-owned groups; exporting retained copies could overwrite newer server edits.
  const serverGroups = new Set([...ids.projectGroupIds, ...linkedGroups])
  const exported = new Set(journaled?.payload.projectGroups.map((group) => group.id))
  return hivewarddSourceStoreWithout(
    store,
    target,
    {
      ...ids,
      repositoryIds: new Set([...ids.repositoryIds, ...linked]),
      folderWorkspaceIds: new Set([...ids.folderWorkspaceIds, ...linkedFolders]),
      projectGroupIds: serverGroups
    },
    moved.at(-1)?.destinationEnvironmentId,
    new Set([...serverGroups].filter((id) => !exported.has(id)))
  )
}

export function hivewarddSourceStoreWithout(
  store: Store,
  target: SshTarget,
  owned: HivewarddMigrationCatalogIds,
  destinationEnvironmentId: string | undefined,
  /** Groups the server's record wins for: never exported, even while a moving row sits in one. */
  serverGroupIds: ReadonlySet<string> = new Set()
): HivewarddDeltaSourceStore {
  const ownedNow = createHivewarddMigrationManifest(store, target, {
    destinationEnvironmentId,
    onlyCatalog: owned
  })
  const view = store.createHivewarddMigrationDeltaView(ownedNow)
  return {
    ...view,
    serverOwnedProjectGroupIds: serverGroupIds,
    getSshTarget: (id) => store.getSshTarget(id),
    getSshRemotePtyLeases: (id) => store.getSshRemotePtyLeases(id),
    readHivewarddMigrationSourceSnapshotChunk: (...args) =>
      store.readHivewarddMigrationSourceSnapshotChunk(...args)
  }
}

export type HivewarddDeltaMovePlan = HivewarddDeltaMovePreview & {
  manifest: HivewarddMigrationManifest
  moved: HivewarddMigrationSourceCutover[]
  head: HivewarddMigrationSourceCutover
  resumes: HivewarddMigrationSourceCutover | null
  source: HivewarddDeltaSourceStore
}

export function planHivewarddDeltaMove(
  userDataPath: string,
  store: Store,
  target: SshTarget,
  options: { migrationId?: string; now?: () => Date } = {}
): HivewarddDeltaMovePlan {
  const environmentId = target.hivewarddFence?.environmentId
  if (!environmentId || !target.hivewarddFence?.sourceChangedAt) {
    throw new Error('hivewardd_delta_not_changed')
  }
  const chain = listHivewarddMigrationCutoverChainForTarget(userDataPath, target.id)
  const resumes = unfinishedHivewarddDelta(chain)
  const moved = committedHivewarddMigrationChain(chain)
  const head = chain.at(resumes ? -2 : -1)
  if (
    !head ||
    !isRetainedHivewarddMigrationSourceCutover(head) ||
    moved.at(-1)?.migrationId !== head.migrationId
  ) {
    throw new Error('hivewardd_delta_no_retained_migration')
  }
  const source = hivewarddDeltaSourceStore(store, target, moved, resumes?.manifest)
  const manifest =
    resumes?.manifest ??
    createHivewarddMigrationManifest(source, target, {
      migrationId: options.migrationId,
      now: options.now,
      destinationEnvironmentId: environmentId
    })
  const current = collectHivewarddMigrationSourceCatalog(store, target)
  return {
    sshTargetId: target.id,
    environmentId,
    added: catalogRows(manifest.payload),
    notReflected: notReflected(
      current,
      moved.map((cutover) => cutover.manifest.payload)
    ),
    blockers: collectUntransferredDependentBlockers(source, manifest),
    manifest,
    moved,
    head,
    resumes,
    source
  }
}

function catalogRows(catalog: HivewarddMigrationCatalogPayload): HivewarddDeltaMoveRow[] {
  return [
    ...catalog.repositories.map((row) => ({
      kind: 'repository' as const,
      id: row.id,
      label: row.displayName
    })),
    ...catalog.folderWorkspaces.map((row) => ({
      kind: 'folder-workspace' as const,
      id: row.id,
      label: row.name
    })),
    ...catalog.projectGroups.map((row) => ({
      kind: 'project-group' as const,
      id: row.id,
      label: row.name
    }))
  ]
}

/** Rows earlier migrations moved that an older build has since changed or removed. */
function notReflected(
  current: HivewarddMigrationCatalogPayload,
  movedPayloads: readonly HivewarddMigrationCatalogPayload[]
): HivewarddDeltaMovePreview['notReflected'] {
  const latestMoved = new Map<string, { row: HivewarddDeltaMoveRow; identity: string }>()
  for (const payload of movedPayloads) {
    for (const row of catalogRows(payload)) {
      latestMoved.set(`${row.kind}:${row.id}`, { row, identity: identityOf(payload, row) })
    }
  }
  const currentByKey = new Map(
    catalogRows(current).map((row) => [`${row.kind}:${row.id}`, identityOf(current, row)])
  )
  const edited: HivewarddDeltaMoveRow[] = []
  const removed: HivewarddDeltaMoveRow[] = []
  for (const [key, moved] of latestMoved) {
    const identity = currentByKey.get(key)
    if (identity === undefined) {
      removed.push(moved.row)
    } else if (identity !== moved.identity) {
      edited.push(moved.row)
    }
  }
  return { edited, removed }
}

function identityOf(catalog: HivewarddMigrationCatalogPayload, row: HivewarddDeltaMoveRow): string {
  switch (row.kind) {
    case 'repository': {
      const repo = catalog.repositories.find((entry) => entry.id === row.id)
      return `${repo?.path}\0${repo?.displayName}`
    }
    case 'folder-workspace': {
      const folder = catalog.folderWorkspaces.find((entry) => entry.id === row.id)
      return `${folder?.folderPath}\0${folder?.name}`
    }
    case 'project-group':
      return catalog.projectGroups.find((entry) => entry.id === row.id)?.name ?? ''
  }
}
