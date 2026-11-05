import type { Automation } from './automations-types'
import type { TuiAgent } from './tui-agent'

export function hivewardAutomationAgent(automation: Pick<Automation, 'agentId'>): TuiAgent {
  if (!automation.agentId) {
    throw new Error('HiveWard 定时需要先选择 Agent')
  }
  return automation.agentId
}
