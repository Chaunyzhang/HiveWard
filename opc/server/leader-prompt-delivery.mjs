import { outsideRequest, rpc } from './api-runtime.mjs'
import { getBusiness } from './business.mjs'
import { getProject } from './business-projects.mjs'
import { firstPromptScreen, terminalChat } from './business-terminals.mjs'
import { settleDispatchDelivery } from './dispatches.mjs'
import { deliverFirstPrompt } from './agent-first-prompt.mjs'
import { appendTimelineEvents } from './timeline.mjs'

function queueSeatPrompt(target, dispatch, onChange, transport) {
  return outsideRequest(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    const terminal = target.seat.terminal
    try {
      await deliverFirstPrompt(
        dispatch.prompt,
        transport ?? {
          screen: () => firstPromptScreen(terminal),
          chat: () => terminalChat(terminal),
          send: (text) => {
            if (!target.current(terminal)) {
              throw new Error(`${target.label}已被替换，首句未发送`)
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
        businessId: target.businessId,
        projectId: target.projectId,
        terminal,
        agent: target.seat.agent,
        path: target.path,
        taskId: dispatch.id,
        kind: 'leader',
        title: `${target.label}首句发送失败：${target.name}`,
        detail: error.message
      })
    } finally {
      onChange()
    }
  })
}

export function queueLeaderPrompt(project, dispatch, onChange, transport) {
  return queueSeatPrompt(
    {
      seat: project.leader,
      businessId: project.businessId,
      projectId: project.id,
      path: project.path,
      name: project.name,
      label: 'Leader Agent ',
      current: (terminal) => getProject(project.id).leader?.terminal === terminal
    },
    dispatch,
    onChange,
    transport
  )
}

export function queueCeoPrompt(business, dispatch, onChange) {
  return queueSeatPrompt(
    {
      seat: business.ceo,
      businessId: business.id,
      path: business.workspacePath,
      name: business.name,
      label: 'CEO ',
      current: (terminal) => getBusiness(business.id).ceo?.terminal === terminal
    },
    dispatch,
    onChange
  )
}
