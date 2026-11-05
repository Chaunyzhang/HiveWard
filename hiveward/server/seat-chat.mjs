import { apiError } from './business.mjs'
import { normalizeSeat } from './seat-occupants.mjs'
import { findSessionTranscript, readChat } from './transcripts.mjs'
import { readPlan } from './session-plan.mjs'

/**
 * 坐在 CEO / Leader 位上的外部会话（Claude 桌面端、开在别处的 Claude Code …）：
 * 按架构图节点 id（ceo:<业务> / leader:<项目>）找到它自己的对话记录，只读地排成消息列表。
 * 只认登记在座位上的会话，不能拿来读任意会话；这里不往会话里写任何东西。
 */
export async function seatSessionChat(details, nodeId, call) {
  const session = normalizeSeat(seatOf(details, nodeId))?.occupant
  if (session?.kind !== 'session') {
    throw apiError(404, 'not_found', '这个座位上没有外部会话')
  }
  const agent = ['claude-desktop', 'claude-code'].includes(session.agent) ? 'claude' : session.agent
  const path = findSessionTranscript(session.agent, session.sessionId, session.cwd)
  const known = ['claude', 'codex', 'kimi'].includes(agent)
  return {
    agent: known ? agent : null,
    source: path,
    items: path ? readChat(agent, path, session.cwd) : [],
    ...(known && path ? { plan: await readPlan(agent, path, call) } : {})
  }
}

function seatOf(details, nodeId) {
  const [kind, id] = [nodeId.slice(0, nodeId.indexOf(':')), nodeId.slice(nodeId.indexOf(':') + 1)]
  if (kind === 'ceo') {
    return details.find((d) => d.business.id === id)?.business.ceo
  }
  if (kind === 'leader') {
    for (const d of details) {
      const project = (d.business.projects ?? []).find((p) => p.id === id)
      if (project) {
        return project.leader
      }
    }
  }
  return undefined
}
