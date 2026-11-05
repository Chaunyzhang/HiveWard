import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import { probeGitRemoteIdentity } from './repo-git-remote-identity'

vi.mock('./git/runner', () => ({ gitExecFileAsync: vi.fn() }))

const gitlabRemote = 'origin\tgit@gitlab.example.com:team/hiveward.git (fetch)\n'
const gitlabIdentity = {
  canonicalKey: 'gitlab.example.com/team/hiveward',
  remoteName: 'origin',
  remoteUrl: 'git@gitlab.example.com:team/hiveward.git'
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('probeGitRemoteIdentity', () => {
  it('resolves the canonical identity for a non-GitHub remote', async () => {
    vi.mocked(gitExecFileAsync).mockResolvedValue({ stdout: gitlabRemote, stderr: '' })

    await expect(probeGitRemoteIdentity('/repos/hiveward', 'local')).resolves.toEqual({
      status: 'resolved',
      identity: gitlabIdentity
    })
  })

  it('reports unavailable for an SSH host', async () => {
    await expect(probeGitRemoteIdentity('/repos/hiveward', 'ssh:builder')).resolves.toEqual({
      status: 'unavailable'
    })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })

  it('refuses a runtime host', async () => {
    await expect(probeGitRemoteIdentity('/repos/hiveward', 'runtime:env-a')).resolves.toEqual({
      status: 'unavailable'
    })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })
})
