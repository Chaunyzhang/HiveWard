import type { SidebarFeedDomains } from '../../../src/shared/sidebar-list/sidebar-feed-domains'
import type { WorkspaceRow } from '../../../src/shared/sidebar-list/workspace-rows'
import {
  parseWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../src/shared/worktree/host-qualified-identity'
import type { ServedProjectSections } from '../worktree/project-sections-operations'
import { INITIAL_MOBILE_VIEW, type MobileViewState } from '../worktree/workspace-view-settings'
import type { Worktree } from '../worktree/workspace-list-types'

export function feedRow(overrides: Partial<WorkspaceRow> & Pick<WorkspaceRow, 'id'>): WorkspaceRow {
  return {
    hostId: 'local',
    kind: 'git',
    repoId: 'hiveward',
    path: `/w/${overrides.id}`,
    branch: overrides.id,
    displayName: overrides.id,
    isMainWorktree: false,
    lineage: null,
    isPinned: false,
    isArchived: false,
    isUnread: false,
    workspaceStatus: 'in-progress',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    linkedItems: [],
    defaultBranch: false,
    ...overrides
  }
}

export const FEED_ROWS = {
  parent: feedRow({
    id: 'hiveward::/w/parent',
    isPinned: true,
    instanceId: 'i-parent',
    manualOrder: 1
  }),
  child: feedRow({
    id: 'hiveward::/w/child',
    instanceId: 'i-child',
    manualOrder: 2,
    lineage: {
      parentWorktreeId: 'hiveward::/w/parent',
      worktreeInstanceId: 'i-child',
      parentWorktreeInstanceId: 'i-parent'
    }
  }),
  remote: feedRow({ id: 'lab::/w/gpu', hostId: 'ssh:gpu', repoId: 'lab', manualOrder: 3 })
}

export function feedKey(identity: string): HostScopedWorktreeKey {
  const key = parseWorktreeHostIdentity(identity)
  if (!key) {
    throw new Error(`not a row identity: ${identity}`)
  }
  return key
}

export function feedDomains(overrides: Partial<SidebarFeedDomains> = {}): SidebarFeedDomains {
  return {
    workspaces: new Map([
      [feedKey('|hiveward::/w/parent'), FEED_ROWS.parent],
      [feedKey('|hiveward::/w/child'), FEED_ROWS.child],
      [feedKey('ssh:gpu|lab::/w/gpu'), FEED_ROWS.remote]
    ]),
    activity: new Map(),
    review: new Map(),
    creations: new Map(),
    pairedServerHosts: new Map(),
    pairedServerRows: new Map(),
    repoIcons: new Map(),
    desktop: {
      desktopActive: { hostId: null, worktreeId: 'hiveward::/w/parent' },
      pinnedWorkspaceIds: ['hiveward::/w/parent'],
      repoOrder: [
        { hostId: 'local', repoId: 'hiveward' },
        { hostId: 'ssh:gpu', repoId: 'lab' }
      ],
      workspaceHostOrder: [],
      sshHosts: { 'ssh:gpu': { label: 'GPU box', status: 'connected' } },
      wslHosts: {}
    },
    projectCatalog: null,
    retention: null,
    ...overrides
  }
}

type ServedRepo = ServedProjectSections['repos'][number]

function servedRepo(fields: Pick<ServedRepo, 'id' | 'path'> & Partial<ServedRepo>): ServedRepo {
  return {
    displayName: fields.id,
    badgeColor: undefined,
    addedAt: undefined,
    connectionId: undefined,
    executionHostId: undefined,
    projectGroupId: undefined,
    projectGroupOrder: undefined,
    ...fields
  }
}

export const SERVED_SECTIONS: ServedProjectSections = {
  repos: [
    servedRepo({ id: 'hiveward', path: '/r/hiveward', badgeColor: '#f00' }),
    servedRepo({ id: 'lab', path: '/r/lab', connectionId: 'gpu' })
  ],
  projects: [],
  setups: [],
  projectOrderBy: 'manual',
  projectGroups: undefined
}

export function phoneView(overrides: Partial<MobileViewState> = {}): MobileViewState {
  return { ...INITIAL_MOBILE_VIEW, groupBy: 'repo', sortBy: 'manual', ...overrides }
}

export function liveRow(overrides: Partial<Worktree> & Pick<Worktree, 'worktreeId'>): Worktree {
  return {
    repoId: 'hiveward',
    repo: 'hiveward',
    branch: overrides.worktreeId,
    displayName: overrides.worktreeId,
    path: `/w/${overrides.worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}
