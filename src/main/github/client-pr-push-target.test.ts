import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
vi.mock('./local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('./github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('./github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

import { getRepoSlug, getRepoUpstream } from './client/fetch/repo-slug-upstream'
import { getWorkItem } from './client/fetch/get-work-item'
import { getPullRequestPushTarget } from './client/lookup/pull-request-push-target'
import { resetPRForBranchMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  getRemoteUrlForRepoMock,
  gitExecFileAsyncMock
} = clientMocks

describe('getPRForBranch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  it('resolves fork PR push target using the origin URL protocol', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'Chaunyzhang', repo: 'HiveWard' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'Chaunyzhang', repo: 'HiveWard' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        head: {
          ref: 'prateek/fix-sidebar-agents-toggle',
          repo: {
            full_name: 'prateek/hiveward',
            name: 'hiveward',
            clone_url: 'https://github.com/prateek/hiveward.git',
            ssh_url: 'git@github.com:prateek/hiveward.git',
            owner: { login: 'prateek' }
          }
        }
      })
    })
    getRemoteUrlForRepoMock.mockResolvedValueOnce('git@github.com:Chaunyzhang/HiveWard.git')

    const target = await getPullRequestPushTarget('/repo-root', 1738)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['api', 'repos/Chaunyzhang/HiveWard/pulls/1738'], {
      cwd: '/repo-root'
    })
    expect(target).toEqual({
      pushTarget: {
        remoteName: 'pr-prateek-hiveward',
        branchName: 'prateek/fix-sidebar-agents-toggle',
        remoteUrl: 'git@github.com:prateek/hiveward.git'
      }
    })
  })

  it('pins explicit origin push-target lookup when upstream has the same PR number', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'fork', repo: 'hiveward' })
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [
        { owner: 'upstream', repo: 'hiveward' },
        { owner: 'fork', repo: 'hiveward' }
      ],
      headRepo: { owner: 'fork', repo: 'hiveward' }
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        head: {
          ref: 'contributor/fix',
          repo: {
            full_name: 'contributor/hiveward',
            name: 'hiveward',
            clone_url: 'https://github.com/contributor/hiveward.git',
            ssh_url: 'git@github.com:contributor/hiveward.git',
            owner: { login: 'contributor' }
          }
        }
      })
    })
    getRemoteUrlForRepoMock.mockResolvedValueOnce('git@github.com:fork/hiveward.git')

    await getPullRequestPushTarget('/repo-root', 1738, null, {}, 'origin')

    expect(resolvePRRepositoryCandidatesMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['api', 'repos/fork/hiveward/pulls/1738'], {
      cwd: '/repo-root',
      host: 'github.com'
    })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['api', 'repos/upstream/hiveward/pulls/1738'],
      expect.anything()
    )
  })

  it('surfaces maintainer_can_modify=false alongside a fork PR push target', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'Chaunyzhang', repo: 'HiveWard' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'Chaunyzhang', repo: 'HiveWard' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        maintainer_can_modify: false,
        head: {
          ref: 'prateek/fix-sidebar-agents-toggle',
          repo: {
            full_name: 'prateek/hiveward',
            name: 'hiveward',
            clone_url: 'https://github.com/prateek/hiveward.git',
            ssh_url: 'git@github.com:prateek/hiveward.git',
            owner: { login: 'prateek' }
          }
        }
      })
    })
    getRemoteUrlForRepoMock.mockResolvedValueOnce('git@github.com:Chaunyzhang/HiveWard.git')

    await expect(getPullRequestPushTarget('/repo-root', 1738)).resolves.toEqual({
      pushTarget: {
        remoteName: 'pr-prateek-hiveward',
        branchName: 'prateek/fix-sidebar-agents-toggle',
        remoteUrl: 'git@github.com:prateek/hiveward.git'
      },
      maintainerCanModify: false
    })
  })

  it('uses origin for same-repository PR push targets', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'Chaunyzhang', repo: 'HiveWard' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'Chaunyzhang', repo: 'HiveWard' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        head: {
          ref: 'fix-sidebar',
          repo: {
            full_name: 'Chaunyzhang/HiveWard',
            name: 'HiveWard',
            clone_url: 'https://github.com/Chaunyzhang/HiveWard.git',
            ssh_url: 'git@github.com:Chaunyzhang/HiveWard.git',
            owner: { login: 'Chaunyzhang' }
          }
        }
      })
    })

    await expect(getPullRequestPushTarget('/repo-root', 1738)).resolves.toEqual({
      pushTarget: {
        remoteName: 'origin',
        branchName: 'fix-sidebar'
      }
    })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps getRepoSlug origin-based on a fork checkout (#7331)', async () => {
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'origin'
        ? { owner: 'fsdwen', repo: 'hiveward' }
        : { owner: 'Chaunyzhang', repo: 'HiveWard' }
    )
    // Set both fixture seams because the bridge prefers the explicit origin probe.
    getOwnerRepoMock.mockResolvedValue({ owner: 'fsdwen', repo: 'hiveward' })

    await expect(getRepoSlug('/repo-root')).resolves.toEqual({
      owner: 'fsdwen',
      repo: 'hiveward',
      host: 'github.com'
    })
  })

  it('resolves a distinct upstream remote as the repo upstream', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'tmchow', repo: 'hiveward' })
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'origin'
        ? { owner: 'tmchow', repo: 'hiveward' }
        : { owner: 'Chaunyzhang', repo: 'HiveWard' }
    )

    await expect(getRepoUpstream('/repo-root')).resolves.toEqual({
      owner: 'Chaunyzhang',
      repo: 'HiveWard'
    })

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not treat a same-repository upstream remote as a fork', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'Chaunyzhang', repo: 'HiveWard' })
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'origin'
        ? { owner: 'Chaunyzhang', repo: 'HiveWard' }
        : { owner: 'Chaunyzhang', repo: 'HiveWard' }
    )
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ isFork: false, parent: null })
    })

    await expect(getRepoUpstream('/repo-root')).resolves.toBeNull()

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      // Explicit positional host prevents ambient GH_HOST redirection.
      ['repo', 'view', 'github.com/Chaunyzhang/HiveWard', '--json', 'isFork,parent'],
      { cwd: '/repo-root', host: 'github.com', timeout: 10_000 }
    )
  })

  it('does not mark an upstream-only GitHub remote as a fork', async () => {
    getOwnerRepoForRemoteMock.mockResolvedValueOnce(null)

    await expect(getRepoUpstream('/repo-root')).resolves.toBeNull()

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledTimes(1)
    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'origin', undefined, {})
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('falls back to the GitHub parent when no upstream remote is configured', async () => {
    getOwnerRepoForRemoteMock
      .mockResolvedValueOnce({ owner: 'tmchow', repo: 'hiveward' })
      .mockResolvedValueOnce(null)
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        isFork: true,
        parent: { name: 'HiveWard', owner: { login: 'Chaunyzhang' } }
      })
    })

    await expect(getRepoUpstream('/repo-root')).resolves.toEqual({
      owner: 'Chaunyzhang',
      repo: 'HiveWard',
      host: 'github.com'
    })
  })

  it('routes GHES push-target probes through the Enterprise host', async () => {
    const ghes = { owner: 'team', repo: 'hiveward', host: 'github.acme-corp.com' }
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [ghes],
      headRepo: ghes
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce(ghes)
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        head: {
          ref: 'feature',
          repo: {
            full_name: 'team/hiveward',
            name: 'hiveward',
            clone_url: 'https://github.acme-corp.com/team/hiveward.git',
            ssh_url: 'git@github.acme-corp.com:team/hiveward.git',
            owner: { login: 'team' }
          }
        }
      })
    })

    await expect(getPullRequestPushTarget('/repo-root', 7)).resolves.toEqual({
      pushTarget: { remoteName: 'origin', branchName: 'feature' }
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'repos/team/hiveward/pulls/7'],
      expect.objectContaining({ host: 'github.acme-corp.com' })
    )
  })

  it('does not confuse same-slug PR repositories across GitHub hosts', async () => {
    const enterprise = { owner: 'team', repo: 'hiveward', host: 'github.acme-corp.com' }
    const dotCom = { owner: 'team', repo: 'hiveward', host: 'github.com' }
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [enterprise, dotCom],
      headRepo: dotCom
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce(dotCom)
    getRemoteUrlForRepoMock.mockResolvedValueOnce('git@github.com:team/hiveward.git')
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        head: {
          ref: 'feature',
          repo: {
            full_name: 'team/hiveward',
            name: 'hiveward',
            clone_url: 'https://github.acme-corp.com/team/hiveward.git',
            ssh_url: 'git@github.acme-corp.com:team/hiveward.git',
            owner: { login: 'team' }
          }
        }
      })
    })

    await expect(getPullRequestPushTarget('/repo-root', 7)).resolves.toEqual({
      pushTarget: {
        remoteName: 'pr-team-hiveward',
        branchName: 'feature',
        remoteUrl: 'git@github.acme-corp.com:team/hiveward.git'
      }
    })
  })

  it('probes additional PR repo candidates when the first lookup is not found', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'fork', repo: 'hiveward' },
        { owner: 'Chaunyzhang', repo: 'HiveWard' }
      ],
      headRepo: { owner: 'fork', repo: 'hiveward' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'fork', repo: 'hiveward' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 404: Not Found'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          head: {
            ref: 'feature/test',
            repo: {
              full_name: 'fork/hiveward',
              name: 'hiveward',
              clone_url: 'https://github.com/fork/hiveward.git',
              ssh_url: 'git@github.com:fork/hiveward.git',
              owner: { login: 'fork' }
            }
          }
        })
      })

    await expect(getPullRequestPushTarget('/repo-root', 1849)).resolves.toEqual({
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/test'
      }
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(1, ['api', 'repos/fork/hiveward/pulls/1849'], {
      cwd: '/repo-root'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', 'repos/Chaunyzhang/HiveWard/pulls/1849'],
      { cwd: '/repo-root' }
    )
  })

  it('probes the next PR work-item candidate after a permission denial', async () => {
    const upstream = { owner: 'upstream', repo: 'hiveward', host: 'github.com' }
    const origin = { owner: 'fork', repo: 'hiveward', host: 'github.com' }
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [upstream, origin],
      headRepo: origin
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL: Resource not accessible by integration'))
      .mockRejectedValueOnce(new Error('GraphQL: Resource not accessible by integration'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Origin PR',
          state: 'OPEN',
          url: 'https://github.com/fork/hiveward/pull/42',
          labels: [],
          updatedAt: '2026-07-16T00:00:00Z',
          author: { login: 'octo' },
          isDraft: false
        })
      })
      .mockRejectedValueOnce(new Error('metadata unavailable'))

    await expect(getWorkItem('/repo-root', 42, 'pr')).resolves.toMatchObject({
      number: 42,
      title: 'Origin PR',
      prRepo: origin
    })

    expect(ghExecFileAsyncMock.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['pr', 'view', '--repo', 'upstream/hiveward'])
    )
    expect(ghExecFileAsyncMock.mock.calls[1][0]).toEqual(['api', 'repos/upstream/hiveward/pulls/42'])
    expect(ghExecFileAsyncMock.mock.calls[2][0]).toEqual(
      expect.arrayContaining(['pr', 'view', '--repo', 'fork/hiveward'])
    )
  })

  it('normalizes reviewer avatars from REST pull request payloads', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Review me',
        state: 'open',
        html_url: 'https://github.com/acme/widgets/pull/42',
        labels: [],
        updated_at: '2026-03-28T00:00:00Z',
        user: { login: 'author' },
        draft: false,
        requested_reviewers: [
          {
            login: 'AmethystLiang',
            avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4'
          }
        ]
      })
    })

    await expect(getWorkItem('/repo-root', 42, 'pr')).resolves.toMatchObject({
      reviewRequests: [
        {
          login: 'AmethystLiang',
          avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
        }
      ]
    })
  })
})
