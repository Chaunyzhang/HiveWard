import { describe, expect, it, vi } from 'vitest'
import { HiveWardRuntimeService } from '../hiveward-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, spawnedPtyEnv, store } from '../hiveward-runtime-test-fixtures.spec'

function makeRuntime(): { runtime: HiveWardRuntimeService; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-workspace-id' })
  const runtime = new HiveWardRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

// Host-created panes need the same workspace id that renderer panes pass to agent wrappers.
describe('HiveWardRuntimeService terminal HIVEWARD_WORKSPACE_ID', () => {
  it('replaces a client-sent value with the host workspace id', async () => {
    const { runtime, spawn } = makeRuntime()

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      env: { HIVEWARD_WORKSPACE_ID: 'stale-client-id' }
    })

    expect(spawnedPtyEnv(spawn.mock.calls[0]?.[0]).HIVEWARD_WORKSPACE_ID).toBe(TEST_WORKTREE_ID)
  })
})
