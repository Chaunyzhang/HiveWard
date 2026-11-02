import { outsideRequest, rpc } from './api-runtime.mjs'
import { getProject } from './business-projects.mjs'
import { firstPromptScreen, terminalChat } from './business-terminals.mjs'
import { settleDispatchDelivery } from './dispatches.mjs'
import { deliverFirstPrompt } from './agent-first-prompt.mjs'
import { appendTimelineEvents } from './timeline.mjs'

export function queueLeaderPrompt(project, dispatch, onChange, transport) {
  return outsideRequest(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    const terminal = project.leader.terminal
    try {
      await deliverFirstPrompt(
        dispatch.prompt,
        transport ?? {
          screen: () => firstPromptScreen(terminal),
          chat: () => terminalChat(terminal),
          send: (text) => {
            if (getProject(project.id).leader?.terminal !== terminal) {
              throw new Error('Leader Agent 已被替换，首句未发送')
            }
            return rpc('terminal.send', { terminal, text, enter: true, agentPrompt: true })
          }
        }
      )
      settleDispatchDelivery(dispatch.id)
    } catch (error) {
      settleDispatchDelivery(dispatch.id, error.message)
      appendTimelineEvents({
        id: `leader-prompt:${dispatch.id}:failed`,
        ts: new Date().toISOString(),
        businessId: project.businessId,
        projectId: project.id,
        terminal,
        agent: project.leader.agent,
        path: project.path,
        taskId: dispatch.id,
        kind: 'leader',
        title: `Leader Agent 首句发送失败：${project.name}`,
        detail: error.message
      })
    } finally {
      onChange()
    }
  })
}
