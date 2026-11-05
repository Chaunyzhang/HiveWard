import {
  launchHivewardSeat,
  bindHivewardSeat,
  tellHivewardSeat,
  unpinHivewardSeat
} from './hiveward-seat-runtime.mjs'
import { invalidate } from './orchestration.mjs'
import { getBusiness, badRequest, apiError, canonicalPath } from './business.mjs'
import {
  getProject,
  updateProject,
  projectPath,
  bindProjectTerminal
} from './business-projects.mjs'
import { rpc } from './api-runtime.mjs'
import { SEAT_AGENTS, agentModel, leaderBrief, observeTerminal } from './business-terminals.mjs'
import { appendTimelineEvents } from './timeline.mjs'
import { normalizeSeat, seatOccupantId, seatOccupantName } from './seat-occupants.mjs'

const launching = new Set()

export function validateSeatLaunch(body) {
  if (!SEAT_AGENTS.includes(body.agent)) {
    throw badRequest('agent 必须为 claude、codex 或 kimi')
  }
  if (body.prompt !== undefined && typeof body.prompt !== 'string') {
    throw badRequest('prompt 必须是字符串')
  }
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
    throw badRequest('model 必须是非空字符串')
  }
  if (body.replace !== undefined && typeof body.replace !== 'boolean') {
    throw badRequest('replace 必须是布尔值')
  }
}

export function seatOccupied(seat, sessionOnly = false) {
  const error = apiError(
    409,
    sessionOnly ? 'seat_is_session' : 'seat_occupied',
    sessionOnly
      ? '这个座位由外部会话坐着，请回对应 Agent 会话里说'
      : `座位已有 ${seatOccupantName(seat)}；确认要顶替请加 --replace`
  )
  error.sessionId = seat?.occupant?.sessionId
  return error
}

export function terminalSeat(terminal, agent, model) {
  return {
    terminal,
    occupant: { kind: 'terminal', terminal },
    agent,
    model: agentModel(agent, model),
    liveness: 'live',
    state: 'idle',
    startedAt: new Date().toISOString()
  }
}

export async function launchProjectLeader(businessId, id, body, { claimTerminal } = {}) {
  if (launching.has(id)) {
    throw apiError(409, 'project_busy', '项目 Leader Agent 正在启动')
  }
  validateSeatLaunch(body)
  launching.add(id)
  try {
    let project = getProject(id, businessId)
    if (project.status !== 'active') {
      throw badRequest('项目已归档')
    }
    const business = getBusiness(businessId)
    const path = projectPath(business, project.dir)
    const listed = await rpc('terminal.list')
    const current = normalizeSeat(project.leader)
    const existing = listed.terminals.find((t) => t.handle === current?.terminal)
    if (current?.occupant?.kind === 'session' && !body.replace) {
      throw seatOccupied(current, !claimTerminal)
    }
    let terminal
    if (claimTerminal) {
      const claimed = listed.terminals.find((t) => t.handle === claimTerminal)
      if (!claimed || canonicalPath(claimed.worktreePath) !== canonicalPath(path)) {
        throw badRequest(`坐 Leader 位必须在项目目录 ${path} 的 Agent 终端里`)
      }
      if (
        current &&
        seatOccupantId(current) !== claimTerminal &&
        (existing || current.occupant?.kind === 'session') &&
        !body.replace
      ) {
        throw seatOccupied(current)
      }
      terminal = claimTerminal
    } else {
      const observed = existing && (await observeTerminal(existing))
      terminal = observed && !observed.exitedToShell && !body.replace ? existing.handle : null
    }
    const created = !terminal
    const claimed = !!claimTerminal
    let native = current?.native
    if (!terminal) {
      const launched = await launchHivewardSeat({
        path,
        agent: body.agent,
        model: body.model,
        brief: leaderBrief(business, project),
        prompt: body.prompt,
        parent:
          business.ceo?.native?.party ??
          (business.ceo?.terminal ? { address: business.ceo.terminal } : undefined)
      })
      terminal = launched.terminal
      native = launched.native
    } else if (!native) {
      native = await bindHivewardSeat({ address: terminal }, leaderBrief(business, project))
    }
    if (created || claimed || !current?.native) {
      if (current?.terminal !== terminal) {
        await unpinHivewardSeat(current)
      }
      project = updateProject(id, {
        path,
        leader: { ...terminalSeat(terminal, body.agent, body.model), native }
      })
      bindProjectTerminal(terminal, id)
      appendTimelineEvents({
        id: `project-leader:${id}:${terminal}:${project.updatedAt}`,
        ts: project.updatedAt,
        businessId,
        projectId: id,
        kind: 'leader',
        title: `${body.agent} 坐上 ${business.name}/${project.name} 的 Leader 位`,
        agent: body.agent,
        terminal,
        path
      })
    }
    if (!created && body.prompt?.trim()) {
      await tellHivewardSeat(project.leader, path, body.prompt)
    }
    invalidate()
    return { project, terminal, brief: leaderBrief(business, project) }
  } finally {
    launching.delete(id)
  }
}
