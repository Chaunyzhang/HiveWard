import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-terminal-contracts'

type AgentRuntime = {
  listTerminals: (
    selector?: string,
    limit?: number,
    options?: { includeVisualLayouts?: boolean }
  ) => Promise<{ terminals: readonly { handle: string }[] }>
  getTerminalAgentStatus: (
    handle: string
  ) => Promise<Pick<RuntimeTerminalAgentStatus, 'isRunningAgent' | 'status'>>
}

// 读取实际运行状态，不能把防休眠租约或当前可见页面当作全部 Agent。
export async function countWorkingUpdateAgents(runtime: AgentRuntime): Promise<number> {
  const { terminals } = await runtime.listTerminals(undefined, Number.MAX_SAFE_INTEGER, {
    includeVisualLayouts: false
  })
  const handles = [...new Set(terminals.map((terminal) => terminal.handle))]
  const statuses = await Promise.all(
    handles.map((handle) => runtime.getTerminalAgentStatus(handle))
  )
  return statuses.filter((status) => status.isRunningAgent && status.status === 'working').length
}
