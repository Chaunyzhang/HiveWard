import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveHiveWardAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveHiveWardAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/hiveward-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveHiveWardAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { PROJECT_HOST_SETUP_HOST_TARGET_RUNTIME_CAPABILITY } from '../shared/worktree-runtime-capabilities'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'

const HIVEWARD_PROJECT = {
  id: 'github:Chaunyzhang/HiveWard',
  displayName: 'HiveWard',
  badgeColor: '#7c3aed',
  sourceRepoIds: ['repo-1'],
  createdAt: 1,
  updatedAt: 1
}
const PROJECT_LIST_FIXTURE = okFixture('req_project_list', { projects: [HIVEWARD_PROJECT] })

describe('hiveward cli worktree awareness', () => {
  const priorExitCode = process.exitCode
  beforeEach(() => {
    process.exitCode = undefined
  })
  afterEach(() => {
    process.exitCode = priorExitCode
  })

  useWorktreeAwarenessEnvironment({
    callMock,
    serveHiveWardAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('resolves repo.add paths against the invoking cli cwd', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_add', {
        repo: {
          id: 'repo-1',
          path: path.resolve('/tmp/repo/apps/web'),
          displayName: 'web'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'add', '--path', './apps/web', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('repo.add', {
      path: path.resolve('/tmp/repo/apps/web')
    })
  })

  it('lists projects through the project-first runtime API', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_list', {
        projects: [
          {
            id: 'github:Chaunyzhang/HiveWard',
            displayName: 'HiveWard',
            badgeColor: '#7c3aed',
            providerIdentity: {
              provider: 'github',
              owner: 'Chaunyzhang',
              repo: 'hiveward'
            },
            sourceRepoIds: ['repo-1'],
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'folder:notes',
            displayName: 'Notes',
            kind: 'folder',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'list'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledExactlyOnceWith('project.list')
    expect(logSpy).toHaveBeenCalledExactlyOnceWith(
      'github:Chaunyzhang/HiveWard  HiveWard  github:Chaunyzhang/hiveward\nfolder:notes  Notes  no-provider'
    )
  })

  it('routes a runtime host filter to that paired server and keeps its own local rows', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-local',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'local',
            repoId: 'repo-local',
            path: '/tmp/hiveward',
            displayName: 'HiveWard',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-remote',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'runtime:gpu',
            repoId: 'repo-remote',
            path: '/srv/hiveward',
            displayName: 'HiveWard',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['project', 'setups', '--project', 'github:Chaunyzhang/HiveWard', '--host', 'runtime:gpu'],
      '/tmp/repo'
    )

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'gpu')
    expect(callMock).toHaveBeenCalledWith('projectHostSetup.list')
    expect(logSpy.mock.calls[0]?.[0]).toContain('setup-remote')
    expect(logSpy.mock.calls[0]?.[0]).toContain('setup-local')
  })

  it('keeps --host local a filter on the selected environment rather than a second selector', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'prod')
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-on-box',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'local',
            repoId: 'repo-on-box',
            path: '/srv/hiveward',
            displayName: 'HiveWard',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-by-client',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'runtime:prod',
            repoId: 'repo-by-client',
            path: '/srv/hiveward-2',
            displayName: 'HiveWard',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'setups', '--environment', 'prod', '--host', 'local'], '/tmp/repo')

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(undefined, 'prod')
    expect(logSpy.mock.calls[0]?.[0]).toContain('setup-on-box')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('setup-by-client')
  })

  it('names the version gap when the server predates project host setup', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'old-server')
    const { RuntimeClientError } = await import('./runtime/types.js')
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('method_not_found', 'Unknown method: projectHostSetup.list')
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['project', 'setups', '--host', 'runtime:old-server', '--json'], '/tmp/repo')

    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(JSON.parse(printed)).toMatchObject({
      ok: false,
      error: { code: 'incompatible_runtime' }
    })
    expect(printed).toContain('does not support project host setup yet')
    expect(printed).not.toContain('Unknown method')
    expect(process.exitCode).toBe(1)
  })

  it('rejects a runtime host id that no paired server owns instead of answering empty', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['project', 'setups', '--host', 'runtime:not-a-real-env', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalledWith('projectHostSetup.list')
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(printed).toContain('no paired HiveWard server is named or has id not-a-real-env')
    expect(JSON.parse(printed)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(JSON.parse(printed).error.data.knownEnvironments).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  it('rejects an unknown ssh host instead of answering empty', async () => {
    queueFixtures(callMock, okFixture('req_ssh_targets', { targets: [] }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['project', 'setups', '--host', 'ssh:openclaw', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalledWith('projectHostSetup.list')
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(JSON.parse(printed)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(printed).toContain('no SSH target named or with id openclaw')
    expect(process.exitCode).toBe(1)
  })

  it('tells a caller reaching for a paired server by ssh that it is an environment', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'awin')
    queueFixtures(callMock, okFixture('req_ssh_targets', { targets: [] }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['project', 'setups', '--host', 'ssh:awin', '--json'], '/tmp/repo')

    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(JSON.parse(printed)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(printed).toContain('--environment awin')
    expect(process.exitCode).toBe(1)
  })

  it('resolves an ssh label to its target id before filtering', async () => {
    queueFixtures(
      callMock,
      okFixture('req_ssh_targets', { targets: [{ id: 'ssh-123-abc', label: 'openclaw' }] }),
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-openclaw',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'ssh:ssh-123-abc',
            repoId: 'repo-openclaw',
            path: '/home/me/hiveward',
            displayName: 'HiveWard',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-other-host',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'ssh:other-target',
            repoId: 'repo-other',
            path: '/home/me/other',
            displayName: 'Other',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'setups', '--host', 'ssh:openclaw'], '/tmp/repo')

    expect(logSpy).toHaveBeenCalledExactlyOnceWith(
      'setup-openclaw  project:github:Chaunyzhang/HiveWard  host:ssh:ssh-123-abc  ready  /home/me/hiveward'
    )
  })

  it('never lets an environment name reach a persisted host id', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-uuid-1', 'awin')
    queueFixtures(
      callMock,
      PROJECT_LIST_FIXTURE,
      okFixture('req_project_setup_create', {
        result: {
          project: {
            id: 'github:Chaunyzhang/HiveWard',
            displayName: 'HiveWard',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-awin',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'local',
            repoId: '',
            path: '',
            displayName: 'awin',
            setupState: 'setting-up',
            setupMethod: 'provisioned',
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-create',
        '--project',
        'github:Chaunyzhang/HiveWard',
        '--host',
        'runtime:awin',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'env-uuid-1')
    expect(callMock).toHaveBeenCalledWith(
      'projectHostSetup.create',
      expect.objectContaining({ hostId: 'runtime:env-uuid-1' })
    )
  })

  it('rejects a malformed --host value before contacting any runtime', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['project', 'setups', '--host', 'runtime:', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(JSON.parse(printed)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(printed).toContain('Invalid --host value: runtime:')
    expect(process.exitCode).toBe(1)
  })

  it('refuses a runtime host id alongside an unrelated --pairing-code connection', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['project', 'setups', '--host', 'runtime:gpu', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(JSON.parse(printed)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(printed).toContain('use either --host runtime:<id> or --pairing-code, not both')
    expect(process.exitCode).toBe(1)
  })

  it('sets up an existing project folder with a path resolved against the local cli cwd', async () => {
    queueFixtures(
      callMock,
      PROJECT_LIST_FIXTURE,
      okFixture('req_project_setup', {
        result: {
          project: {
            id: 'github:Chaunyzhang/HiveWard',
            displayName: 'HiveWard',
            badgeColor: '#7c3aed',
            sourceRepoIds: ['repo-1'],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-local',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'local',
            repoId: 'repo-1',
            path: path.resolve('/tmp/hiveward'),
            displayName: 'HiveWard',
            setupState: 'ready',
            setupMethod: 'imported-existing-folder',
            createdAt: 1,
            updatedAt: 1
          },
          repo: {
            id: 'repo-1',
            path: path.resolve('/tmp/hiveward'),
            displayName: 'HiveWard',
            badgeColor: '#7c3aed',
            addedAt: 1
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-existing-folder',
        '--project',
        'github:Chaunyzhang/HiveWard',
        '--host',
        'local',
        '--path',
        '..',
        '--kind',
        'git',
        '--display-name',
        'HiveWard',
        '--json'
      ],
      '/tmp/hiveward/worktrees/feature'
    )

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.setupExistingFolder', {
      projectId: 'github:Chaunyzhang/HiveWard',
      hostId: 'local',
      path: path.resolve('/tmp/hiveward/worktrees'),
      kind: 'git',
      displayName: 'HiveWard'
    })
  })

  it('rejects remote project setup relative paths instead of resolving against client cwd', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-existing-folder',
        '--project',
        'github:Chaunyzhang/HiveWard',
        '--host',
        'runtime:gpu',
        '--path',
        './hiveward',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(JSON.parse(printed)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(printed).toContain(
      'Remote project setup requires --path to be an absolute path on the remote server.'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects SSH project setup relative paths, which name the client filesystem', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-existing-folder',
        '--project',
        'github:Chaunyzhang/HiveWard',
        '--host',
        'ssh:openclaw',
        '--path',
        './hiveward',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(JSON.parse(printed)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(printed).toContain(
      'Remote project setup requires --path to be an absolute path on the remote server.'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects remote repo.add relative paths instead of resolving against client cwd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['repo', 'add', '--path', './apps/web', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(JSON.parse(printed)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(printed).toContain(
      'Remote repo add requires --path to be an absolute path on the remote server.'
    )
    expect(process.exitCode).toBe(1)
  })

  it('sends remote repo.add absolute paths unchanged', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_add', {
        repo: {
          id: 'repo-1',
          path: '/srv/hiveward/web',
          displayName: 'web'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['repo', 'add', '--path', '/srv/hiveward/web', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('repo.add', {
      path: '/srv/hiveward/web'
    })
  })

  it.each(['C:\\repo', 'C:/repo', '\\\\server\\share\\repo', '//server/share/repo'])(
    'sends remote repo.add server absolute path %s unchanged',
    async (serverPath) => {
      queueFixtures(
        callMock,
        okFixture('req_repo_add', {
          repo: {
            id: 'repo-1',
            path: serverPath,
            displayName: 'web'
          }
        })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(
        ['repo', 'add', '--path', serverPath, '--pairing-code', 'remote-runtime', '--json'],
        '/tmp/repo'
      )

      expect(callMock).toHaveBeenCalledWith('repo.add', {
        path: serverPath
      })
    }
  )

  it('sends a windows destination to the routed host instead of joining it to the local cwd', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'awin')
    queueFixtures(
      callMock,
      PROJECT_LIST_FIXTURE,
      okFixture('req_project_setup_clone', {
        result: {
          project: {
            id: 'github:Chaunyzhang/HiveWard',
            displayName: 'HiveWard',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-awin',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'local',
            repoId: 'repo-awin',
            path: 'C:\\hiveward-probe\\hiveward',
            displayName: 'HiveWard',
            setupState: 'ready',
            setupMethod: 'cloned',
            createdAt: 1,
            updatedAt: 1
          },
          repo: {
            id: 'repo-awin',
            path: 'C:\\hiveward-probe\\hiveward',
            displayName: 'HiveWard',
            badgeColor: '#7c3aed',
            addedAt: 1
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-clone',
        '--project',
        'github:Chaunyzhang/HiveWard',
        '--host',
        'runtime:awin',
        '--url',
        'https://github.com/Chaunyzhang/HiveWard.git',
        '--destination',
        'C:\\hiveward-probe',
        '--json'
      ],
      '/Users/nwparker/hiveward/workspaces/hiveward/IME-koko'
    )

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'awin')
    expect(callMock).toHaveBeenCalledWith('projectHostSetup.clone', {
      projectId: 'github:Chaunyzhang/HiveWard',
      hostId: 'runtime:awin',
      url: 'https://github.com/Chaunyzhang/HiveWard.git',
      destination: 'C:\\hiveward-probe',
      displayName: undefined
    })
  })

  it('updates project host setup metadata through the project-first runtime API', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setup_update', {
        result: {
          project: {
            id: 'github:Chaunyzhang/HiveWard',
            displayName: 'HiveWard',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-gpu',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'runtime:gpu',
            repoId: '',
            path: '/srv/hiveward',
            displayName: 'GPU VM',
            setupState: 'ready',
            setupMethod: 'imported-existing-folder',
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-update',
        '--setup',
        'setup-gpu',
        '--display-name',
        'GPU VM',
        '--path',
        '/srv/hiveward',
        '--worktree-base-path',
        '../worktrees',
        '--state',
        'ready',
        '--method',
        'imported-existing-folder',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.update', {
      setupId: 'setup-gpu',
      updates: {
        displayName: 'GPU VM',
        path: path.resolve('/tmp/repo', '/srv/hiveward'),
        worktreeBasePath: '../worktrees',
        gitUsername: undefined,
        kind: undefined,
        setupState: 'ready',
        setupMethod: 'imported-existing-folder'
      }
    })
  })

  it('creates independent project host setup metadata through the project-first runtime API', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    queueFixtures(
      callMock,
      PROJECT_LIST_FIXTURE,
      okFixture('req_project_setup_create', {
        result: {
          project: {
            id: 'github:Chaunyzhang/HiveWard',
            displayName: 'HiveWard',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-gpu',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'runtime:gpu',
            repoId: '',
            path: '',
            displayName: 'GPU VM',
            setupState: 'setting-up',
            setupMethod: 'provisioned',
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-create',
        '--project',
        'github:Chaunyzhang/HiveWard',
        '--host',
        'runtime:gpu',
        '--setup-id',
        'setup-gpu',
        '--display-name',
        'GPU VM',
        '--state',
        'setting-up',
        '--method',
        'provisioned',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.create', {
      projectId: 'github:Chaunyzhang/HiveWard',
      hostId: 'runtime:gpu',
      setupId: 'setup-gpu',
      path: undefined,
      kind: undefined,
      displayName: 'GPU VM',
      worktreeBasePath: undefined,
      gitUsername: undefined,
      setupState: 'setting-up',
      setupMethod: 'provisioned'
    })
  })

  it.each([
    { flags: [], force: false, hostId: undefined },
    { flags: ['--force'], force: true, hostId: undefined },
    { flags: ['--host', 'local'], force: false, hostId: 'local' }
  ])('deletes project host setup metadata with $flags', async ({ flags, force, hostId }) => {
    queueFixtures(
      callMock,
      ...(hostId ? [hostTargetStatusFixture(true)] : []),
      okFixture('req_project_setup_delete', {
        result: {
          project: {
            id: 'github:Chaunyzhang/HiveWard',
            displayName: 'HiveWard',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-gpu',
            projectId: 'github:Chaunyzhang/HiveWard',
            hostId: 'runtime:gpu',
            repoId: '',
            path: '/srv/hiveward',
            displayName: 'GPU VM',
            setupState: 'ready',
            setupMethod: 'imported-existing-folder',
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'setup-delete', '--setup', 'setup-gpu', ...flags, '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.delete', {
      setupId: 'setup-gpu',
      hostId,
      force
    })
  })

  it('refuses --host on a server that would ignore it and act on the first same-id twin', async () => {
    queueFixtures(callMock, hostTargetStatusFixture(false))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['project', 'setup-delete', '--setup', 'dup', '--host', 'local', '--force', '--json'],
      '/tmp/repo'
    )

    expect(callMock.mock.calls).toEqual([['status.get']])
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'incompatible_runtime',
        message: expect.stringContaining('cannot pick a project setup by host yet')
      }
    })
    expect(process.exitCode).toBe(1)
  })
})

function hostTargetStatusFixture(supported: boolean) {
  return okFixture('req_status', {
    capabilities: supported ? [PROJECT_HOST_SETUP_HOST_TARGET_RUNTIME_CAPABILITY] : []
  })
}
