import { describe, expect, it, vi } from 'vitest'
import { HiveWardRuntimeService } from '../hiveward-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  store
} from '../hiveward-runtime-test-fixtures.spec'

describe('HiveWardRuntimeService', () => {
  it('rejects a qualified removal when only another host has persisted ownership', async () => {
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' })
    }
    const runtime = new HiveWardRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      listResolvedWorktrees: () => Promise<unknown[]>
      resolveWorktreeRemovalTarget: (
        worktreeSelector: string,
        requiredHostId?: string
      ) => Promise<unknown>
    }
    internals.listResolvedWorktrees = vi.fn().mockResolvedValue([
      {
        id: TEST_WORKTREE_ID,
        repoId: TEST_REPO_ID,
        path: TEST_WORKTREE_PATH,
        hostId: 'local'
      }
    ])

    await expect(
      internals.resolveWorktreeRemovalTarget(TEST_WORKTREE_ID, 'runtime:env-b')
    ).rejects.toThrow('selector_not_found')
    expect(internals.listResolvedWorktrees).not.toHaveBeenCalled()
  })
})
