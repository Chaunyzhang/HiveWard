/** Empty-host claims refuse all referencing state; migrations block only state their manifest cannot carry. */
import type { Store } from '../../persistence/loading-store/store'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { toSshExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { getRepoRegistrationHostIds } from '../../../shared/repo-host-identity'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { GLOBAL_WORKSPACE_SESSION_FIELDS } from '../../../shared/workspace-session-host-field-ownership'
import {
  HIVEWARDD_MIGRATION_DEPENDENCY_KINDS,
  type HivewarddMigrationBlocker,
  type HivewarddMigrationDependency,
  type HivewarddMigrationDependencyKind
} from '../../../shared/hivewardd-migration/hivewardd-migration-preflight'
import type { HivewarddMigrationManifest } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'

export type DependentStateStore = Pick<
  Store,
  | 'getAllWorktreeMetaForHost'
  | 'getProjects'
  | 'getRepos'
  | 'getSshRemotePtyLeases'
  | 'getWorkspaceSession'
  | 'getWorkspaceSessionHostIds'
  | 'listAutomations'
>

const MAX_NAMES = 5

export function collectDependentStateBlockers(
  store: DependentStateStore,
  targetId: string
): HivewarddMigrationBlocker[] {
  const hostId = toSshExecutionHostId(targetId)
  const readers: [HivewarddMigrationDependencyKind, () => string[]][] = [
    ['workspace-session', () => workspaceSessionReferences(store, hostId)],
    [
      'automation',
      () =>
        store
          .listAutomations()
          .filter((a) => a.executionTargetType === 'ssh' && a.executionTargetId === targetId)
          .map((a) => a.name)
    ],
    ['worktree-metadata', () => hostWorktreeMetadataNames(store, hostId)],
    // Why every status: a terminated lease is still a saved record pointing at this host.
    [
      'terminal-lease',
      () => store.getSshRemotePtyLeases(targetId).map((lease) => `${lease.ptyId} (${lease.state})`)
    ]
  ]
  const dependencies: HivewarddMigrationDependency[] = []
  const unreadable: HivewarddMigrationDependencyKind[] = []
  for (const [kind, read] of readers) {
    let names: string[]
    try {
      names = read()
    } catch {
      unreadable.push(kind)
      continue
    }
    if (names.length > 0) {
      dependencies.push({ kind, count: names.length, names: names.slice(0, MAX_NAMES) })
    }
  }
  const blockers: HivewarddMigrationBlocker[] = []
  if (dependencies.length > 0) {
    blockers.push({
      code: 'hivewardd_migration_dependent_state',
      category: 'client-owned-state',
      dependencies
    })
  }
  if (unreadable.length > 0) {
    blockers.push({
      code: 'hivewardd_migration_dependency_unverifiable',
      category: 'live-or-unverifiable',
      sources: unreadable
    })
  }
  return blockers
}

/** Kinds with their own blockers (port forwards, terminal leases) are counted elsewhere. */
const CENSUS_DEPENDENCY_KINDS = HIVEWARDD_MIGRATION_DEPENDENCY_KINDS.filter(
  (kind) => kind !== 'saved-port-forward' && kind !== 'terminal-lease'
)

/** Block only untransferred dependencies; an unavailable census is unverifiable, never empty. */
export function collectUntransferredDependentBlockers(
  store: Pick<Store, 'inspectHivewarddMigrationUntransferredDependencies'>,
  manifest: HivewarddMigrationManifest
): HivewarddMigrationBlocker[] {
  let census: ReturnType<Store['inspectHivewarddMigrationUntransferredDependencies']>
  try {
    census = store.inspectHivewarddMigrationUntransferredDependencies(manifest)
  } catch {
    return [
      {
        code: 'hivewardd_migration_dependency_unverifiable',
        category: 'live-or-unverifiable',
        sources: [...CENSUS_DEPENDENCY_KINDS]
      }
    ]
  }
  const dependencies = CENSUS_DEPENDENCY_KINDS.filter((kind) => census.counts[kind] > 0).map(
    (kind) => {
      const names = census.names?.[kind]?.slice(0, MAX_NAMES)
      return { kind, count: census.counts[kind], ...(names?.length ? { names } : {}) }
    }
  )
  return dependencies.length > 0
    ? [{ code: 'hivewardd_migration_dependent_state', category: 'client-owned-state', dependencies }]
    : []
}

/** Legacy unstamped metadata projects to every host: count registered repos or cross-host projects, but exclude unmanageable orphan repos (#31498). */
function hostWorktreeMetadataNames(store: DependentStateStore, hostId: ExecutionHostId): string[] {
  const repos = store.getRepos()
  const projectIds = new Set(store.getProjects().map((project) => project.id))
  return Object.entries(store.getAllWorktreeMetaForHost(hostId))
    .filter(([worktreeId, meta]) => {
      if (meta.hostId) {
        return meta.hostId === hostId
      }
      const ownerId = getRepoIdFromWorktreeId(worktreeId)
      return getRepoRegistrationHostIds(repos, ownerId).has(hostId) || projectIds.has(ownerId)
    })
    .map(([worktreeId]) => worktreeId)
}

/** Ignore client-global fields copied into host partitions; include local sessions referencing this host. */
function workspaceSessionReferences(store: DependentStateStore, hostId: string): string[] {
  const references: string[] = []
  if (store.getWorkspaceSession().activeWorkspaceExecutionHostId === hostId) {
    references.push('active workspace')
  }
  if (!store.getWorkspaceSessionHostIds().some((id) => id === hostId)) {
    return references
  }
  const defaults: Record<string, unknown> = { ...getDefaultWorkspaceSession() }
  // A partition's global fields are copies of client-wide focus and history, not host state.
  const globalFields = new Set<string>(GLOBAL_WORKSPACE_SESSION_FIELDS)
  for (const [field, value] of Object.entries(store.getWorkspaceSession(hostId))) {
    if (globalFields.has(field)) {
      continue
    }
    if (!isEmptyValue(value) && JSON.stringify(value) !== JSON.stringify(defaults[field])) {
      references.push(field)
    }
  }
  return references
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  if (Array.isArray(value)) {
    return value.length === 0
  }
  return typeof value === 'object' && Object.keys(value).length === 0
}

export function dependentStateSummary(dependencies: HivewarddMigrationDependency[]): string {
  return dependencies
    .map(
      ({ kind, count, names }) =>
        `${kind} ×${count}${names?.length ? ` (${names.join(', ')})` : ''}`
    )
    .join('; ')
}

export function dependentStateMessage(dependencies: HivewarddMigrationDependency[]): string {
  return (
    'This SSH target is still referenced by saved HiveWard state that this host’s HiveWard server cannot take ' +
    `over yet: ${dependentStateSummary(dependencies)}. Remove it, or keep this host in direct SSH mode.`
  )
}
