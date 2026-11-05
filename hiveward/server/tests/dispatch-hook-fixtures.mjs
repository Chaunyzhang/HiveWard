// 脱敏的 last-status → terminal.agentStatus 形状；时间只用于本轮 / 上一轮边界。
export const HOOK_ROUND_START = '2026-11-04T08:00:00.000Z'
export const HOOK_LATER_ROUND_START = '2026-11-04T08:10:00.000Z'

const at = (iso) => Date.parse(iso)
const done = (agentType, overrides) => ({
  isRunningAgent: true,
  status: 'idle',
  state: 'done',
  agentType,
  stateStartedAt: at('2026-11-04T08:05:00.000Z'),
  updatedAt: at('2026-11-04T08:05:01.000Z'),
  ...overrides
})

export const KIMI_EMPTY_PROMPT_DONE = done('kimi', {
  prompt: '',
  lastAssistantMessage: ''
})

export const CODEX_EMPTY_PROMPT_DONE = done('codex', {
  prompt: '',
  lastAssistantMessage: 'hook 有正文也不能证明属于哪一单'
})

export const TERMINAL_STEER_DONE = done('kimi', {
  prompt: '额度恢复了，接着做',
  lastAssistantMessage: '本轮真正完成的汇报'
})

export const PREVIOUS_ROUND_DONE = done('codex', {
  prompt: '上一轮终端里的旧话',
  lastAssistantMessage: '上一轮旧汇报'
})
