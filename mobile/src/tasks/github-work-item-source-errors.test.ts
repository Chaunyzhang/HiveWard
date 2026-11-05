import { describe, expect, it } from 'vitest'
import {
  extractGitHubIssueSourceError,
  extractGitHubIssueSourceFallback
} from './github-work-item-source-errors'

describe('extractGitHubIssueSourceError', () => {
  it('keeps the failing issue source slug with the repo that produced it', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/hiveward' },
        {
          sources: { issues: { owner: 'upstream', repo: 'hiveward' } },
          errors: { issues: { message: 'HTTP 403: resource not accessible' } }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/hiveward',
      source: { owner: 'upstream', repo: 'hiveward' },
      message: 'HTTP 403: resource not accessible'
    })
  })

  it('drops issue errors when the source slug is unavailable', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/hiveward' },
        {
          sources: { issues: null },
          errors: { issues: { message: 'failed' } }
        }
      )
    ).toBeNull()
  })

  it('returns null when the envelope has no issue-side error', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/hiveward' },
        {
          sources: { issues: { owner: 'stablyai', repo: 'hiveward' } }
        }
      )
    ).toBeNull()
  })
})

describe('extractGitHubIssueSourceFallback', () => {
  it('reports the repo whose upstream issue source fell back to origin', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/hiveward', displayName: 'hiveward' },
        {
          issueSourceFellBack: true,
          sources: {
            issues: { owner: 'stablyai', repo: 'hiveward-fork' },
            prs: { owner: 'stablyai', repo: 'hiveward' }
          }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/hiveward',
      repoLabel: 'Chaunyzhang/HiveWard'
    })
  })

  it('uses the HiveWard repo display name when the PR source is unavailable', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/hiveward', displayName: 'hiveward' },
        {
          issueSourceFellBack: true,
          sources: { issues: null, prs: null }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/hiveward',
      repoLabel: 'hiveward'
    })
  })

  it('returns null when the source resolver did not fall back', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/hiveward', displayName: 'hiveward' },
        {
          sources: { issues: { owner: 'stablyai', repo: 'hiveward' } }
        }
      )
    ).toBeNull()
  })
})
