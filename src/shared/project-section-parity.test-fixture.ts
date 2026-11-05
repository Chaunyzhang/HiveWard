// Host answers both the desktop sidebar's and the phone's Project grouping tests run on.
import type { MobileProjectSectionCatalog } from './mobile-project-sections-contract'
import type { ExecutionHostId } from './execution-host'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from './project-host-setup-projection'
import type { Repo } from './repo-types'
import type { RuntimeClientTarget } from './runtime-client-target'

const hivewardRemote = {
  canonicalKey: 'github.com/Chaunyzhang/HiveWard',
  remoteName: 'origin',
  remoteUrl: 'git@github.com:Chaunyzhang/HiveWard.git'
}

function hostRepo(id: string, path: string, displayName = 'hiveward'): Repo {
  return {
    id,
    path,
    displayName,
    badgeColor: '#737373',
    addedAt: 1,
    ...(displayName === 'hiveward' ? { gitRemoteIdentity: hivewardRemote } : {})
  }
}

export type ParityHostAnswer = {
  target: RuntimeClientTarget
  hostId: ExecutionHostId
  /** In the host's own repo.list order. */
  repos: Repo[]
  /** The host's project.list/projectHostSetup.list rows; null for a host that predates them. */
  lists: ProjectHostSetupProjection | null
}

const localRepos = [
  hostRepo('local-stably', '/Users/jinwoo/stably/hiveward'),
  hostRepo('local-assets', '/Users/jinwoo/design-assets', 'design-assets'),
  hostRepo('local-workspace', '/Users/jinwoo/hiveward/workspaces/hiveward/hiveward')
]
const windowsRepo = hostRepo('win-hiveward', 'C:/Users/jinwo/hiveward/hiveward')

// Several local checkouts plus copies of the same project on two servers.
export const PROJECT_SECTION_PARITY_HOSTS: readonly ParityHostAnswer[] = [
  {
    target: { kind: 'local' },
    hostId: 'local',
    repos: localRepos,
    lists: projectHostSetupProjectionFromRepos(localRepos)
  },
  {
    target: { kind: 'environment', environmentId: 'windows2' },
    hostId: 'runtime:windows2',
    repos: [windowsRepo],
    // A server's own catalog rows: its project name and an imported setup on its local host.
    lists: {
      projects: [
        {
          id: 'github:Chaunyzhang/HiveWard',
          displayName: 'HiveWard',
          badgeColor: '#737373',
          providerIdentity: { provider: 'github', owner: 'Chaunyzhang', repo: 'hiveward' },
          sourceRepoIds: [windowsRepo.id],
          createdAt: 5,
          updatedAt: 5
        }
      ],
      setups: [
        {
          id: 'win-setup',
          projectId: 'github:Chaunyzhang/HiveWard',
          hostId: 'local',
          repoId: windowsRepo.id,
          path: windowsRepo.path,
          displayName: 'hiveward',
          setupState: 'ready',
          setupMethod: 'imported-existing-folder',
          createdAt: 5,
          updatedAt: 5
        }
      ]
    }
  },
  {
    target: { kind: 'environment', environmentId: 'm4air' },
    hostId: 'runtime:m4air',
    repos: [
      hostRepo('m4-hiveward', '/Users/m4air/hiveward/hiveward'),
      hostRepo('m4-hiveward-two', '/Users/m4air/hiveward-two/hiveward')
    ],
    lists: null
  }
]

/** Workspace rows; activity order differs from catalog order, so Recent and Manual disagree. */
export const PROJECT_SECTION_PARITY_ROWS: readonly {
  id: string
  repoId: string
  lastActivityAt: number
}[] = [
  { id: 'wt-m4-two', repoId: 'm4-hiveward-two', lastActivityAt: 90 },
  { id: 'wt-win', repoId: 'win-hiveward', lastActivityAt: 70 },
  { id: 'wt-workspace', repoId: 'local-workspace', lastActivityAt: 50 },
  { id: 'wt-stably', repoId: 'local-stably', lastActivityAt: 30 },
  { id: 'wt-m4', repoId: 'm4-hiveward', lastActivityAt: 10 }
]

// Same-host checkouts still need path prefixes; other machines do not.
const STABLY = {
  key: 'project:github:Chaunyzhang/HiveWard::setup:local-stably',
  label: 'stably/hiveward'
}
const WORKSPACE = {
  key: 'project:github:Chaunyzhang/HiveWard::setup:local-workspace',
  label: 'hiveward/hiveward'
}
// Why 'hiveward', not the server's 'HiveWard': the later host's derived project name wins the merge.
const WINDOWS = { key: 'project:github:Chaunyzhang/HiveWard', label: 'hiveward' }
const M4 = { key: 'project:github:Chaunyzhang/HiveWard::setup:m4-hiveward', label: 'hiveward/hiveward' }
const M4_TWO = {
  key: 'project:github:Chaunyzhang/HiveWard::setup:m4-hiveward-two',
  label: 'hiveward-two/hiveward'
}
const ASSETS = { key: 'project:repo:local-assets', label: 'design-assets' }

export const PROJECT_SECTION_PARITY_HEADERS = {
  recent: [M4_TWO, WINDOWS, WORKSPACE, STABLY, M4, ASSETS],
  manual: [STABLY, ASSETS, WORKSPACE, WINDOWS, M4, M4_TWO]
} as const

/** What main serves the phone for these answers (the renderer's published catalog). */
export const PROJECT_SECTION_PARITY_SERVED: MobileProjectSectionCatalog = {
  repos: [
    {
      id: 'local-stably',
      displayName: 'hiveward',
      path: '/Users/jinwoo/stably/hiveward',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'local-assets',
      displayName: 'design-assets',
      path: '/Users/jinwoo/design-assets',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'local-workspace',
      displayName: 'hiveward',
      path: '/Users/jinwoo/hiveward/workspaces/hiveward/hiveward',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'win-hiveward',
      displayName: 'hiveward',
      path: 'C:/Users/jinwo/hiveward/hiveward',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:windows2'
    },
    {
      id: 'm4-hiveward',
      displayName: 'hiveward',
      path: '/Users/m4air/hiveward/hiveward',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:m4air'
    },
    {
      id: 'm4-hiveward-two',
      displayName: 'hiveward',
      path: '/Users/m4air/hiveward-two/hiveward',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:m4air'
    }
  ],
  projects: [
    { id: 'repo:local-assets', displayName: 'design-assets' },
    { id: 'github:Chaunyzhang/HiveWard', displayName: 'hiveward' }
  ],
  setups: [
    {
      id: 'local-stably',
      projectId: 'github:Chaunyzhang/HiveWard',
      hostId: 'local',
      repoId: 'local-stably',
      path: '/Users/jinwoo/stably/hiveward',
      displayName: 'hiveward',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'local-assets',
      projectId: 'repo:local-assets',
      hostId: 'local',
      repoId: 'local-assets',
      path: '/Users/jinwoo/design-assets',
      displayName: 'design-assets',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'local-workspace',
      projectId: 'github:Chaunyzhang/HiveWard',
      hostId: 'local',
      repoId: 'local-workspace',
      path: '/Users/jinwoo/hiveward/workspaces/hiveward/hiveward',
      displayName: 'hiveward',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'win-setup',
      projectId: 'github:Chaunyzhang/HiveWard',
      hostId: 'runtime:windows2',
      repoId: 'win-hiveward',
      path: 'C:/Users/jinwo/hiveward/hiveward',
      displayName: 'hiveward',
      setupMethod: 'imported-existing-folder',
      connectionId: null,
      executionHostId: 'runtime:windows2'
    },
    {
      id: 'm4-hiveward',
      projectId: 'github:Chaunyzhang/HiveWard',
      hostId: 'runtime:m4air',
      repoId: 'm4-hiveward',
      path: '/Users/m4air/hiveward/hiveward',
      displayName: 'hiveward',
      setupMethod: 'legacy-repo',
      executionHostId: 'runtime:m4air'
    },
    {
      id: 'm4-hiveward-two',
      projectId: 'github:Chaunyzhang/HiveWard',
      hostId: 'runtime:m4air',
      repoId: 'm4-hiveward-two',
      path: '/Users/m4air/hiveward-two/hiveward',
      displayName: 'hiveward',
      setupMethod: 'legacy-repo',
      executionHostId: 'runtime:m4air'
    }
  ],
  projectOrderBy: 'manual'
}
