import { describe, expect, it, vi } from 'vitest'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { watchInWatcherProcessMock, watchMock } from './hiveward-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './hiveward-runtime-files-test-harness'

vi.mock('fs', async () => (await import('./hiveward-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./hiveward-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./hiveward-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem/filesystem-auth', async () =>
  (await import('./hiveward-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./hiveward-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./hiveward-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)

describe('RuntimeFileCommands', () => {
  useRuntimeFileCommandsLifecycle()

  it('refuses an SSH runtime watch without watching this machine', async () => {
    const { commands, store } = createRuntimeFileCommands({ path: '/remote/repo' })
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(commands.watchFileExplorer('id:wt-1', vi.fn())).rejects.toThrow(
      SshHostNotServedError
    )
    expect(watchInWatcherProcessMock).not.toHaveBeenCalled()
    expect(watchMock).not.toHaveBeenCalled()
  })
})
