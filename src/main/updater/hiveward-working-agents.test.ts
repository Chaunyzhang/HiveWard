import { expect, it, vi } from 'vitest'
import { countWorkingUpdateAgents } from './hiveward-working-agents'

it('合并重复句柄，读取所有 Agent 而非列表默认第一页', async () => {
  const statuses = [
    { isRunningAgent: true, status: 'working' },
    { isRunningAgent: true, status: 'idle' },
    { isRunningAgent: false, status: 'working' },
    { isRunningAgent: true, status: 'permission' }
  ] as const
  const runtime = {
    listTerminals: vi.fn(async () => ({
      terminals: [0, 1, 2, 3, 0].map(String).map((handle) => ({ handle }))
    })),
    getTerminalAgentStatus: vi.fn(async (handle: string) => statuses[Number(handle)])
  }
  expect(await countWorkingUpdateAgents(runtime)).toBe(1)
  expect(runtime.getTerminalAgentStatus).toHaveBeenCalledTimes(4)
  expect(runtime.listTerminals).toHaveBeenCalledWith(undefined, Number.MAX_SAFE_INTEGER, {
    includeVisualLayouts: false
  })
})

it('状态读取失败时拒绝把未知人数当成零', async () => {
  await expect(
    countWorkingUpdateAgents({
      listTerminals: async () => ({ terminals: [{ handle: 'agent' }] }),
      getTerminalAgentStatus: async () => {
        throw new Error('状态不可用')
      }
    })
  ).rejects.toThrow('状态不可用')
})
