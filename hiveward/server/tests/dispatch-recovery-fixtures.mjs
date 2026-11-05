// 脱敏的重启恢复形状：top-level 没有 fresh hook，最后状态单独放在 lastStatus。
export const RECOVERY_ROUND_START = '2026-11-04T08:10:00.000Z'
export const RECOVERY_PROMPT = '复核没通过：补齐恢复测试'

export const RESTART_NO_HOOK = {
  isRunningAgent: true,
  status: null
}

export const RESTORED_ROUND_DONE = {
  state: 'done',
  prompt: RECOVERY_PROMPT,
  lastAssistantMessage: '恢复后认出本轮汇报',
  stateStartedAt: Date.parse('2026-11-04T08:15:00.000Z'),
  updatedAt: Date.parse('2026-11-04T08:15:01.000Z')
}

export const RESTORED_PREVIOUS_ROUND_DONE = {
  ...RESTORED_ROUND_DONE,
  lastAssistantMessage: '上一轮旧汇报',
  stateStartedAt: Date.parse('2026-11-04T08:05:00.000Z'),
  updatedAt: Date.parse('2026-11-04T08:05:01.000Z')
}
