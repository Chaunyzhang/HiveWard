/** HiveWard 定时没选 Agent 只能停用；要启用必须先选 Agent。返回要并入更新的字段。 */
export function automationEnabledWithoutAgent(
  agentId: string | null | undefined,
  enabled: boolean | undefined
): { enabled?: false } {
  if (agentId) {
    return {}
  }
  if (enabled === true) {
    throw new Error('HiveWard 定时需要先选择 Agent')
  }
  return { enabled: false }
}
