import { describe, expect, it } from 'vitest'
import { getLocalExecutionHostLabel } from '../../../src/shared/execution-host'
import {
  buildNewWorkspaceProjectOptions,
  buildNewWorkspaceRunTargetOptions,
  getNewWorkspaceRunTarget
} from './new-workspace-project-targets'

const LOCAL_HOST_LABEL = getLocalExecutionHostLabel('darwin')

describe('new workspace project targets', () => {
  it('groups local and SSH checkouts of the same project', () => {
    const upstream = { owner: 'stablyai', repo: 'hiveward' }
    const options = buildNewWorkspaceProjectOptions([
      { id: 'local', displayName: 'hiveward', path: '/src/hiveward', upstream },
      {
        id: 'ssh',
        displayName: 'hiveward',
        path: '/home/dev/hiveward',
        connectionId: 'build-server',
        upstream
      }
    ])

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ label: 'hiveward', detail: 'Chaunyzhang/HiveWard' })
  })

  it('shows the provider slug recovered from canonical git identity', () => {
    const options = buildNewWorkspaceProjectOptions([
      {
        id: 'local',
        displayName: 'hiveward',
        path: '/src/hiveward',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/Chaunyzhang/HiveWard',
          remoteName: 'origin',
          remoteUrl: 'git@github.com:Chaunyzhang/HiveWard.git'
        }
      }
    ])

    expect(options[0]).toMatchObject({ label: 'hiveward', detail: 'Chaunyzhang/HiveWard' })
  })

  it('labels local, SSH, and paired runtime targets as the host list names them', () => {
    expect(
      getNewWorkspaceRunTarget({ id: 'local', displayName: 'hiveward', path: '/src/hiveward' }, 'darwin')
    ).toEqual({ hostId: 'local', label: LOCAL_HOST_LABEL, detail: '/src/hiveward' })
    expect(
      getNewWorkspaceRunTarget({ id: 'local', displayName: 'hiveward', path: 'C:\\src\\hiveward' })
    ).toMatchObject({ label: 'This computer' })
    expect(
      getNewWorkspaceRunTarget({ id: 'local', displayName: 'hiveward', path: 'C:\\src\\hiveward' }, 'win32')
    ).toMatchObject({ label: 'Local Windows' })
    expect(
      getNewWorkspaceRunTarget({
        id: 'ssh',
        displayName: 'hiveward',
        path: 'C:\\src\\hiveward',
        executionHostId: 'ssh:Windows%20VM'
      })
    ).toEqual({ hostId: 'ssh:Windows%20VM', label: 'Windows VM', detail: 'C:\\src\\hiveward' })
    const server = {
      id: 'runtime',
      displayName: 'hiveward',
      path: '/src/hiveward',
      executionHostId: 'runtime:20269ff3-60aa-4e79-a581-513a3f8e394b'
    } as const
    const labels = new Map([[server.executionHostId, 'scratch-server']] as const)
    expect(getNewWorkspaceRunTarget(server, 'darwin', labels)).toEqual({
      hostId: server.executionHostId,
      label: 'scratch-server',
      detail: '/src/hiveward'
    })
  })

  it('shows one target per host when the project has multiple local worktrees', () => {
    const upstream = { owner: 'stablyai', repo: 'hiveward' }
    const repos = [
      { id: 'local-a', displayName: 'hiveward-a', path: '/src/hiveward-a', upstream },
      { id: 'local-b', displayName: 'hiveward-b', path: '/src/hiveward-b', upstream },
      {
        id: 'ssh',
        displayName: 'hiveward',
        path: '/home/dev/hiveward',
        connectionId: 'build-server',
        upstream
      }
    ]
    const projectId = buildNewWorkspaceProjectOptions(repos)[0]?.id ?? null

    expect(buildNewWorkspaceRunTargetOptions(repos, projectId, 'darwin')).toEqual([
      expect.objectContaining({ id: 'local', label: LOCAL_HOST_LABEL, detail: '/src/hiveward-a' }),
      expect.objectContaining({
        id: 'ssh:build-server',
        label: 'build-server',
        detail: '/home/dev/hiveward'
      })
    ])
  })
})
