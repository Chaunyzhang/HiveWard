/** Hide migrated rows while managed, retaining them for downgraded clients. Only newly added projects/folders mark sourceChangedAt and require explicit delta migration; edits/removals/groups never overwrite server state or trigger automatic merging. */
import { createHash } from 'node:crypto'
import { getAppEnvironment } from '../../shared/app-environment'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { HivewarddMigrationCatalogPayload } from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import {
  MAX_HIVEWARDD_MIGRATION_FOLDER_WORKSPACES,
  MAX_HIVEWARDD_MIGRATION_REPOSITORIES
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest-validation'
import {
  isRetainedHivewarddMigrationSourceCutover,
  type HivewarddMigrationSourceCutover
} from '../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import type { Repo } from '../../shared/repo-types'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { getHivewarddSshDeployment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence/loading-store/store'
import { collectHivewarddMigrationSourceCatalog } from '../persistence/migrating-hivewardd-catalog/hivewardd-source-catalog'
import {
  hivewarddSourceFolderWorkspaceIds,
  projectGroupBelongsToHivewarddSource,
  repoBelongsToHivewarddSource
} from '../persistence/migrating-hivewardd-catalog/hivewardd-source-ownership'
import {
  findHivewarddMigrationSourceCutoverForTarget,
  listHivewarddMigrationCutoverChainForTarget,
  writeHivewarddMigrationSourceCutover
} from './hivewardd-migration-cutover-journal'
import { hivewarddMigrationCatalogIds } from './hivewardd-migration-manifest-export'
import {
  withoutWslMovedFolderWorkspaces,
  withoutWslMovedRepos
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'

export const appUserDataPath = (): string => getAppEnvironment().getPath('userData')

type CatalogStore = Pick<Store, 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'>
type TargetStore = Pick<Store, 'getSshTargets' | 'updateSshTarget'>

/** Hide only retained committed source without later additions; in-flight or unjournaled fences leave source rows visible. */
function isHiddenRetainedSourceTarget(
  userDataPath: string,
  target: Pick<SshTarget, 'id' | 'hivewarddFence'>
): boolean {
  if (!target.hivewarddFence || target.hivewarddFence.sourceChangedAt) {
    return false
  }
  let head: HivewarddMigrationSourceCutover | null
  try {
    head = findHivewarddMigrationSourceCutoverForTarget(userDataPath, target.id)
  } catch {
    return true // An unreadable journal keeps the host fenced, and so hidden.
  }
  return (
    head !== null &&
    (head.phase === 'destination-committed' ||
      head.phase === 'source-retired' ||
      head.destinationEnvironmentId !== target.hivewarddFence.environmentId)
  )
}

/** Delay journal reads until a host is fenced. */
export function hiddenRetainedSourceTargetIds(
  getUserDataPath: () => string,
  targets: readonly SshTarget[]
): string[] {
  return targets
    .filter(
      (target) => target.hivewarddFence && isHiddenRetainedSourceTarget(getUserDataPath(), target)
    )
    .map((target) => target.id)
}

/** Freeze fenced ssh: partitions: renderer saves could mutate in-flight source or strip retained rows after commit. */
export function isFrozenHivewarddSourceSessionPartition(
  store: Pick<Store, 'getSshTarget'>,
  hostId: string | null | undefined
): boolean {
  const parsed = parseExecutionHostId(hostId)
  const fence = parsed?.kind === 'ssh' ? store.getSshTarget(parsed.targetId)?.hivewarddFence : undefined
  return fence !== undefined && !fence.sourceChangedAt
}

export function visibleRepos(
  store: CatalogStore & Pick<Store, 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): Repo[] {
  return reposShownWith(
    store.getRepos(),
    hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  )
}

function reposShownWith(allRepos: Repo[], hiddenTargets: readonly string[]): Repo[] {
  const repos = withoutWslMovedRepos(allRepos)
  if (hiddenTargets.length === 0) {
    return repos
  }
  return repos.filter(
    (repo) => !hiddenTargets.some((targetId) => repoBelongsToHivewarddSource(repo, targetId))
  )
}

/** Keep local groups that merely contain host-owned projects. */
export function visibleProjectGroups(
  store: Pick<Store, 'getProjectGroups' | 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): ProjectGroup[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const groups = store.getProjectGroups()
  if (hidden.length === 0) {
    return groups
  }
  return groups.filter(
    (group) => !hidden.some((targetId) => projectGroupBelongsToHivewarddSource(group, targetId))
  )
}

export function visibleFolderWorkspaces(
  store: CatalogStore & Pick<Store, 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): FolderWorkspace[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const folderWorkspaces = withoutWslMovedFolderWorkspaces(store.getFolderWorkspaces())
  if (hidden.length === 0) {
    return folderWorkspaces
  }
  const state = {
    repos: store.getRepos(),
    projectGroups: store.getProjectGroups(),
    folderWorkspaces
  }
  const hiddenIds = new Set(
    hidden.flatMap((targetId) => [...hivewarddSourceFolderWorkspaceIds(state, targetId)])
  )
  return folderWorkspaces.filter((workspace) => !hiddenIds.has(workspace.id))
}

/** Hide setups with their source repo rows so managed server listings do not duplicate same-id setups (#30859). */
export function visibleProjectHostSetups(
  store: CatalogStore & Pick<Store, 'getProjectHostSetups' | 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): ProjectHostSetup[] {
  const setups = store.getProjectHostSetups()
  if (setups.length === 0) {
    return setups
  }
  const hiddenTargets = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const allRepos = store.getRepos()
  const shownRepos = reposShownWith(allRepos, hiddenTargets)
  if (hiddenTargets.length === 0 && shownRepos.length === allRepos.length) {
    return setups
  }
  const rowKey = (hostId: string, repoId: string): string => `${hostId}\0${repoId}`
  const shownKeys = new Set(shownRepos.map((repo) => rowKey(getRepoExecutionHostId(repo), repo.id)))
  const hiddenKeys = new Set(
    allRepos
      .map((repo) => rowKey(getRepoExecutionHostId(repo), repo.id))
      .filter((key) => !shownKeys.has(key))
  )
  return setups.filter((setup) => {
    if (setup.repoId && hiddenKeys.has(rowKey(setup.hostId, setup.repoId))) {
      return false
    }
    // Repo-less placeholders have no row to follow, so the hidden host decides for them.
    const host = parseExecutionHostId(setup.hostId)
    return !(host?.kind === 'ssh' && hiddenTargets.includes(host.targetId))
  })
}

/** Keep the identity-only fingerprint format stable for older builds; timestamps must not create source changes. */
export function hivewarddCatalogFingerprint(catalog: HivewarddMigrationCatalogPayload): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        catalog.repositories.map((repo) => `${repo.id}\0${repo.path}`).sort(),
        catalog.folderWorkspaces.map((folder) => `${folder.id}\0${folder.folderPath}`).sort(),
        catalog.projectGroups.map((group) => group.id).sort()
      ])
    )
    .digest('hex')
}

export function currentHivewarddSourceFingerprint(
  store: CatalogStore,
  target: Pick<SshTarget, 'id'>
): string {
  return hivewarddCatalogFingerprint(collectHivewarddMigrationSourceCatalog(store, target))
}

type UnmovedHivewarddSourceRows = { repositoryIds: string[]; folderWorkspaceIds: string[] }

/** Delta candidates exclude moved/linked/explicitly kept projects and folders. Group organization alone never represents new server work. */
export function unmovedHivewarddSourceRows(
  current: HivewarddMigrationCatalogPayload,
  chain: readonly HivewarddMigrationSourceCutover[]
): UnmovedHivewarddSourceRows {
  const moved = hivewarddMigrationCatalogIds(chain.map((cutover) => cutover.manifest.payload))
  const repositories = new Set([
    ...moved.repositoryIds,
    ...chain.flatMap((cutover) => [
      ...(cutover.linkedRepositoryIds ?? []),
      ...(cutover.keptRepositoryIds ?? [])
    ])
  ])
  const folders = new Set([
    ...moved.folderWorkspaceIds,
    ...chain.flatMap((cutover) => [
      ...(cutover.linkedFolderWorkspaceIds ?? []),
      ...(cutover.keptFolderWorkspaceIds ?? [])
    ])
  ])
  return {
    repositoryIds: current.repositories.map((row) => row.id).filter((id) => !repositories.has(id)),
    folderWorkspaceIds: current.folderWorkspaces
      .map((row) => row.id)
      .filter((id) => !folders.has(id))
  }
}

function retainedHivewarddSourceBaseline(head: HivewarddMigrationSourceCutover): string {
  return head.sourceBaselineFingerprint ?? hivewarddCatalogFingerprint(head.manifest.payload)
}

export function withKeptHivewarddSourceRows(
  head: HivewarddMigrationSourceCutover,
  unmoved: UnmovedHivewarddSourceRows
): HivewarddMigrationSourceCutover {
  const keptRepositoryIds = [...(head.keptRepositoryIds ?? []), ...unmoved.repositoryIds]
  const keptFolderWorkspaceIds = [
    ...(head.keptFolderWorkspaceIds ?? []),
    ...unmoved.folderWorkspaceIds
  ]
  // Beyond kept-row bounds, the baseline fingerprint still records explicit reconciliation.
  return keptRepositoryIds.length <= MAX_HIVEWARDD_MIGRATION_REPOSITORIES &&
    keptFolderWorkspaceIds.length <= MAX_HIVEWARDD_MIGRATION_FOLDER_WORKSPACES
    ? { ...head, keptRepositoryIds, keptFolderWorkspaceIds }
    : head
}

type RetainedSourceReview = {
  verdict: 'unchanged' | 'changed'
  unrecordedKeptRows: UnmovedHivewarddSourceRows | null
}

/** New rows mark changed only when baseline differs; older explicit-keeps lack row lists and rely on that baseline. */
function reviewRetainedHivewarddSource(
  store: CatalogStore,
  target: Pick<SshTarget, 'id'>,
  chain: readonly HivewarddMigrationSourceCutover[],
  head: HivewarddMigrationSourceCutover
): RetainedSourceReview {
  const current = collectHivewarddMigrationSourceCatalog(store, target)
  const unmoved = unmovedHivewarddSourceRows(current, chain)
  if (unmoved.repositoryIds.length === 0 && unmoved.folderWorkspaceIds.length === 0) {
    return { verdict: 'unchanged', unrecordedKeptRows: null }
  }
  if (hivewarddCatalogFingerprint(current) !== retainedHivewarddSourceBaseline(head)) {
    return { verdict: 'changed', unrecordedKeptRows: null }
  }
  return { verdict: 'unchanged', unrecordedKeptRows: unmoved }
}

/** At startup, restore generation-matched managed fences and detect retained-source additions. Failed reconciliation leaves state unchanged. */
export function reconcileManagedHivewarddSshTargets(
  userDataPath: string,
  store: CatalogStore & TargetStore,
  now: () => Date = () => new Date()
): void {
  try {
    restoreFencesFromManagedServers(userDataPath, store)
    markChangedRetainedSources(userDataPath, store, now)
  } catch (error) {
    console.warn('[ssh] Could not reconcile managed HiveWard server hosts:', error)
  }
}

function restoreFencesFromManagedServers(userDataPath: string, store: TargetStore): void {
  const targets = new Map(store.getSshTargets().map((target) => [target.id, target]))
  for (const environment of listEnvironments(userDataPath)) {
    const deployment = getHivewarddSshDeployment(environment)
    const target = deployment ? targets.get(deployment.sshTargetId) : undefined
    // Recreated ids identify new registrations; restore fences only for matching generation.
    if (target && !target.hivewarddFence && target.generation === deployment?.sshTargetGeneration) {
      store.updateSshTarget(target.id, { hivewarddFence: { environmentId: environment.id } })
    }
  }
}

function markChangedRetainedSources(
  userDataPath: string,
  store: CatalogStore & TargetStore,
  now: () => Date
): void {
  for (const target of store.getSshTargets()) {
    const fence = target.hivewarddFence
    const chain = fence ? listHivewarddMigrationCutoverChainForTarget(userDataPath, target.id) : []
    const head = chain.at(-1)
    if (!fence || !head || fence.environmentId !== head.destinationEnvironmentId) {
      continue
    }
    // Restore an interrupted delta's changed mark so reconnect resumes its journal.
    const interruptedDelta =
      head.supersedesMigrationId !== undefined &&
      (head.phase === 'source-fenced' || head.phase === 'destination-staged')
    const review =
      !interruptedDelta && isRetainedHivewarddMigrationSourceCutover(head)
        ? reviewRetainedHivewarddSource(store, target, chain, head)
        : null
    const kept = review?.unrecordedKeptRows
      ? withKeptHivewarddSourceRows(head, review.unrecordedKeptRows)
      : head
    if (kept !== head) {
      // Record kept rows once so later group edits cannot turn them into new additions.
      writeHivewarddMigrationSourceCutover(userDataPath, kept)
    }
    if (fence.sourceChangedAt) {
      // Clear older builds' marks for removals/group edits that delta migration cannot carry (#31523).
      if (review?.verdict === 'unchanged') {
        const { sourceChangedAt: _lifted, ...unmarked } = fence
        store.updateSshTarget(target.id, { hivewarddFence: unmarked })
      }
      continue
    }
    if (interruptedDelta || review?.verdict === 'changed') {
      store.updateSshTarget(target.id, {
        hivewarddFence: { ...fence, sourceChangedAt: now().toISOString() }
      })
    }
  }
}
