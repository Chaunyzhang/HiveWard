import { describe, expect, it } from 'vitest'
import {
  dropFailedGitHubRepoSlugEntries,
  filterGitHubProjectRowsForRepos,
  findRepoForGitHubProjectRepository,
  normalizeGitHubRepositorySlug
} from './github-project-repo-match'

const repos = [
  { id: 'repo-1', path: '/Users/me/hiveward', displayName: 'hiveward' },
  { id: 'repo-2', path: '/Users/me/other', displayName: 'other' }
]

describe('GitHub project repo matching', () => {
  it('normalizes owner/repo slugs case-insensitively', () => {
    expect(normalizeGitHubRepositorySlug(' StablyAI/HiveWard ')).toBe('Chaunyzhang/HiveWard')
    expect(normalizeGitHubRepositorySlug('hiveward')).toBeNull()
    expect(normalizeGitHubRepositorySlug('Chaunyzhang/HiveWard/extra')).toBeNull()
  })

  it('matches project rows by resolved repo slug before path/display heuristics', () => {
    expect(
      findRepoForGitHubProjectRepository('Chaunyzhang/HiveWard', repos, {
        'repo-1': {
          path: '/Users/me/hiveward',
          repository: { owner: 'stablyai', repo: 'hiveward' }
        }
      })
    ).toBe(repos[0])
  })

  it('does not pick a repo when resolved slugs are ambiguous', () => {
    expect(
      findRepoForGitHubProjectRepository('Chaunyzhang/HiveWard', repos, {
        'repo-1': {
          path: '/Users/me/hiveward',
          repository: { owner: 'stablyai', repo: 'hiveward' }
        },
        'repo-2': {
          path: '/Users/me/other',
          repository: { owner: 'stablyai', repo: 'hiveward' }
        }
      })
    ).toBeNull()
  })

  it('falls back to exact display/path slug matching when slug resolution is unavailable', () => {
    expect(
      findRepoForGitHubProjectRepository('Chaunyzhang/HiveWard', [
        { id: 'repo-1', path: '/Users/me/Chaunyzhang/HiveWard', displayName: 'hiveward' }
      ])
    ).toEqual({ id: 'repo-1', path: '/Users/me/Chaunyzhang/HiveWard', displayName: 'hiveward' })
  })

  it('normalizes Windows paths before path slug fallback matching', () => {
    expect(
      findRepoForGitHubProjectRepository('Chaunyzhang/HiveWard', [
        { id: 'repo-1', path: 'C:\\Users\\me\\stablyai\\hiveward', displayName: 'hiveward' }
      ])
    ).toEqual({ id: 'repo-1', path: 'C:\\Users\\me\\stablyai\\hiveward', displayName: 'hiveward' })
  })

  it('does not path-match a repo whose resolved slug points somewhere else', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'Chaunyzhang/HiveWard',
        [{ id: 'repo-1', path: '/Users/me/Chaunyzhang/HiveWard', displayName: 'hiveward' }],
        {
          'repo-1': {
            path: '/Users/me/Chaunyzhang/HiveWard',
            repository: { owner: 'fork', repo: 'hiveward' }
          }
        }
      )
    ).toBeNull()
  })

  it('keeps draft and restricted items while filtering repository-backed rows', () => {
    const rows = [
      { id: 'row-1', itemType: 'ISSUE', content: { repository: 'Chaunyzhang/HiveWard' } },
      { id: 'row-2', itemType: 'ISSUE', content: { repository: 'other/missing' } },
      { id: 'row-3', itemType: 'REDACTED', content: { repository: null } },
      { id: 'row-4', itemType: 'ISSUE', content: { repository: null } },
      ...Array.from({ length: 67 }, (_, index) => ({
        id: `draft-${index}`,
        itemType: 'DRAFT_ISSUE',
        content: { repository: null }
      }))
    ]

    expect(
      filterGitHubProjectRowsForRepos(rows, repos, {
        'repo-1': {
          path: '/Users/me/hiveward',
          repository: { owner: 'stablyai', repo: 'hiveward' }
        }
      }).map((row) => row.id)
    ).toEqual(['row-1', 'row-3', ...Array.from({ length: 67 }, (_, index) => `draft-${index}`)])
  })

  it('matches same-named repositories only on the active Project host', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'Chaunyzhang/HiveWard',
        repos,
        {
          'repo-1': {
            path: '/Users/me/hiveward',
            repository: { owner: 'stablyai', repo: 'hiveward', host: 'github.com' }
          },
          'repo-2': {
            path: '/Users/me/other',
            repository: {
              owner: 'stablyai',
              repo: 'hiveward',
              host: 'github.acme-corp.com'
            }
          }
        },
        'github.acme-corp.com'
      )
    ).toBe(repos[1])
  })

  it('matches an upstream project row against a fork clone', () => {
    const fork = {
      id: 'repo-1',
      path: '/Users/me/r2r-mirror',
      displayName: 'r2r-mirror',
      upstream: { owner: 'SciPhi-AI', repo: 'R2R' }
    }

    expect(
      findRepoForGitHubProjectRepository('SciPhi-AI/R2R', [fork], {
        'repo-1': {
          path: '/Users/me/r2r-mirror',
          repository: { owner: 'me', repo: 'r2r-mirror' }
        }
      })
    ).toBe(fork)
  })

  it('prefers the clone that owns the slug over a fork of it', () => {
    const upstreamClone = { id: 'repo-1', path: '/Users/me/r2r', displayName: 'r2r' }
    const fork = {
      id: 'repo-2',
      path: '/Users/me/r2r-mirror',
      displayName: 'r2r-mirror',
      upstream: { owner: 'SciPhi-AI', repo: 'R2R' }
    }

    expect(
      findRepoForGitHubProjectRepository('SciPhi-AI/R2R', [upstreamClone, fork], {
        'repo-1': {
          path: '/Users/me/r2r',
          repository: { owner: 'SciPhi-AI', repo: 'R2R' }
        },
        'repo-2': {
          path: '/Users/me/r2r-mirror',
          repository: { owner: 'me', repo: 'r2r-mirror' }
        }
      })
    ).toBe(upstreamClone)
  })

  it('does not pick a repo when two forks share the same upstream', () => {
    const forks = [
      {
        id: 'repo-1',
        path: '/Users/me/a',
        displayName: 'a',
        upstream: { owner: 'SciPhi-AI', repo: 'R2R' }
      },
      {
        id: 'repo-2',
        path: '/Users/me/b',
        displayName: 'b',
        upstream: { owner: 'SciPhi-AI', repo: 'R2R' }
      }
    ]

    expect(
      findRepoForGitHubProjectRepository('SciPhi-AI/R2R', forks, {
        'repo-1': { path: '/Users/me/a', repository: { owner: 'me', repo: 'a' } },
        'repo-2': { path: '/Users/me/b', repository: { owner: 'me', repo: 'b' } }
      })
    ).toBeNull()
  })

  it('does not bind a github.com fork parent to a same-named Enterprise row', () => {
    const fork = {
      id: 'repo-1',
      path: '/Users/me/r2r-mirror',
      displayName: 'r2r-mirror',
      upstream: { owner: 'SciPhi-AI', repo: 'R2R' }
    }

    expect(
      findRepoForGitHubProjectRepository(
        'SciPhi-AI/R2R',
        [fork],
        {
          'repo-1': {
            path: '/Users/me/r2r-mirror',
            repository: { owner: 'me', repo: 'r2r-mirror', host: 'github.com' }
          }
        },
        'github.acme-corp.com'
      )
    ).toBeNull()
  })

  it('drops the fork alias while its own origin is unresolved', () => {
    const fork = {
      id: 'repo-1',
      path: '/Users/me/widgets-mirror',
      displayName: 'widgets-mirror',
      upstream: { owner: 'acme', repo: 'widgets' }
    }

    for (const slugs of [
      {},
      { 'repo-1': { path: '/Users/me/widgets-mirror', repository: null } },
      { 'repo-1': { path: '/moved', repository: { owner: 'me', repo: 'widgets' } } }
    ]) {
      expect(findRepoForGitHubProjectRepository('acme/widgets', [fork], slugs)).toBeNull()
    }
  })

  it('scopes a host-less fork parent to the host the fork itself was cloned from', () => {
    const enterpriseFork = {
      id: 'repo-1',
      path: '/Users/me/widgets-mirror',
      displayName: 'widgets-mirror',
      upstream: { owner: 'acme', repo: 'widgets' }
    }
    const slugs = {
      'repo-1': {
        path: '/Users/me/widgets-mirror',
        repository: { owner: 'me', repo: 'widgets', host: 'github.acme-corp.com' }
      }
    }

    expect(
      findRepoForGitHubProjectRepository(
        'acme/widgets',
        [enterpriseFork],
        slugs,
        'github.acme-corp.com'
      )
    ).toBe(enterpriseFork)
    expect(findRepoForGitHubProjectRepository('acme/widgets', [enterpriseFork], slugs)).toBeNull()
  })

  it('does not use hostless path heuristics for Enterprise Project rows', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'Chaunyzhang/HiveWard',
        [{ id: 'repo-1', path: '/Users/me/Chaunyzhang/HiveWard', displayName: 'hiveward' }],
        {},
        'github.acme-corp.com'
      )
    ).toBeNull()
  })

  // Transient slug failures must be retried instead of caching no repository forever.
  it('leaves a failed slug lookup matchable by the path fallback', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'Chaunyzhang/HiveWard',
        [{ id: 'repo-1', path: '/Users/me/Chaunyzhang/HiveWard', displayName: 'hiveward' }],
        { 'repo-1': { path: '/Users/me/Chaunyzhang/HiveWard', repository: null, failed: true } }
      )
    ).toEqual({ id: 'repo-1', path: '/Users/me/Chaunyzhang/HiveWard', displayName: 'hiveward' })
  })
})

describe('dropFailedGitHubRepoSlugEntries', () => {
  it('drops only the entries a retry could still resolve', () => {
    expect(
      dropFailedGitHubRepoSlugEntries({
        'repo-1': { path: '/a', repository: { owner: 'stablyai', repo: 'hiveward' } },
        'repo-2': { path: '/b', repository: null, failed: true },
        'repo-3': { path: '/c', repository: null }
      })
    ).toEqual({
      'repo-1': { path: '/a', repository: { owner: 'stablyai', repo: 'hiveward' } },
      'repo-3': { path: '/c', repository: null }
    })
  })

  // Preserve cache identity on no-op refreshes so the slug effect does not refetch needlessly.
  it('returns the same object when nothing failed', () => {
    const cache = { 'repo-1': { path: '/a', repository: null } }
    expect(dropFailedGitHubRepoSlugEntries(cache)).toBe(cache)
  })
})
