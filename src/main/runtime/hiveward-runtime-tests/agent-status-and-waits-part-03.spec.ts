import { describe, expect, it, vi } from 'vitest'
import { HiveWardRuntimeService } from '../hiveward-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../hiveward-runtime-test-fixtures.spec'

describe('HiveWardRuntimeService', () => {
  it('keeps ordinary terminal send suffix failures on the existing not-writable contract', async () => {
    const writes: string[] = []
    const beforeWrite = vi.fn()
    const afterWrite = vi.fn()
    const runtime = new HiveWardRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: (_ptyId: string, data: string) => {
        writes.push(data)
        return data !== '\r'
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex ready',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
    try {
      await Promise.all([
        expect(
          runtime.sendTerminal(
            terminal.handle,
            { text: 'notes', enter: true },
            { inputKind: 'driving', beforeWrite, afterWrite }
          )
        ).rejects.toThrow('terminal_not_writable'),
        vi.runAllTimersAsync()
      ])
      expect(writes).toEqual(['notes', '\r'])
      expect(beforeWrite).toHaveBeenCalledTimes(2)
      expect(afterWrite).toHaveBeenCalledOnce()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
