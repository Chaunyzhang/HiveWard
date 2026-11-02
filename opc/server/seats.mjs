import { randomUUID } from 'node:crypto'
import { getBusiness, updateBusiness, apiError, badRequest, canonicalPath } from './business.mjs'
import { getProject, updateProject } from './business-projects.mjs'
import { ensureRepo, rpc } from './api-runtime.mjs'
import { agentCommand, ceoBrief, leaderBrief, observeTerminal } from './business-terminals.mjs'
import { seatOccupied, terminalSeat, validateSeatLaunch } from './project-leaders.mjs'
import {
  normalizeSeat,
  seatOccupantId,
  seatOccupantName,
  summarizeSeat
} from './seat-occupants.mjs'
import { exitRegionGuard } from './agent-exit-region.mjs'
import { recordDispatch } from './dispatches.mjs'
import { appendTimelineEvents } from './timeline.mjs'
import { queueCeoPrompt } from './leader-prompt-delivery.mjs'
import { invalidate } from './orchestration.mjs'

const launching = new Set()
const SESSION_AGENTS = new Set(['claude', 'claude-desktop', 'claude-code', 'codex', 'kimi'])

function targetOf(body) {
  if (!['ceo', 'leader'].includes(body.seat)) {
    throw badRequest('seat 必须为 ceo 或 leader')
  }
  const business = getBusiness(body.businessId)
  if (body.seat === 'leader' && !body.projectId) {
    throw badRequest('Leader 位需要 projectId')
  }
  const project = body.seat === 'leader' ? getProject(body.projectId, business.id) : null
  if (project?.status !== 'active' && body.seat === 'leader') {
    throw badRequest('项目已归档')
  }
  return {
    business,
    project,
    seat: normalizeSeat(project ? project.leader : business.ceo),
    path: project?.path ?? business.workspacePath
  }
}

function saveTarget(target, seat) {
  if (target.project) {
    target.project = updateProject(target.project.id, { leader: seat })
  } else {
    target.business = updateBusiness(target.business.id, { ceo: seat })
  }
  target.seat = seat
  return seat
}

function brief(target) {
  return target.project ? leaderBrief(target.business, target.project) : ceoBrief(target.business)
}

function seatEvent(target, title, seat) {
  const ts = new Date().toISOString()
  appendTimelineEvents({
    id: `seat:${randomUUID()}`,
    ts,
    businessId: target.business.id,
    projectId: target.project?.id,
    kind: 'leader',
    title,
    agent: seat?.agent,
    terminal: seat?.terminal,
    path: target.path
  })
}

export async function claimSeat(body) {
  const target = targetOf(body)
  const session = body.session
  if (
    !session ||
    typeof session.sessionId !== 'string' ||
    !session.sessionId.trim() ||
    !SESSION_AGENTS.has(session.agent) ||
    typeof session.cwd !== 'string' ||
    !session.cwd.trim()
  ) {
    throw badRequest('session 需要 sessionId、有效 agent 和 cwd')
  }
  if (body.replace !== undefined && typeof body.replace !== 'boolean') {
    throw badRequest('replace 必须是布尔值')
  }
  const listed = await rpc('terminal.list')
  const occupied =
    target.seat?.occupant?.kind === 'session' ||
    listed.terminals.some((t) => t.handle === target.seat?.terminal)
  if (occupied && seatOccupantId(target.seat) === session.sessionId) {
    return { brief: brief(target), seat: summarizeSeat(target.seat, listed.terminals, []) }
  }
  if (occupied && !body.replace) {
    throw seatOccupied(target.seat)
  }
  const now = new Date().toISOString()
  const seat = {
    occupant: {
      kind: 'session',
      sessionId: session.sessionId,
      agent: session.agent,
      cwd: session.cwd
    },
    agent: session.agent,
    liveness: 'unverifiable',
    state: 'idle',
    startedAt: now
  }
  saveTarget(target, seat)
  const where = `${target.business.name}${target.project ? `/${target.project.name}` : ''}`
  seatEvent(
    target,
    `${session.agent}（${session.sessionId}）坐上 ${where} 的 ${target.project ? 'Leader' : 'CEO'} 位`,
    seat
  )
  invalidate()
  return { brief: brief(target), seat: summarizeSeat(seat, listed.terminals, []) }
}

export function leaveSeat(body, caller) {
  const target = targetOf(body)
  if (!target.seat) {
    return { seat: null }
  }
  if (target.seat.occupant?.kind === 'session') {
    if (body.sessionId !== target.seat.occupant.sessionId) {
      throw apiError(403, 'forbidden', '只有坐在这个座位上的会话本人能离座')
    }
  } else if (caller?.kind === 'agent' && caller.id !== seatOccupantId(target.seat)) {
    throw apiError(403, 'forbidden', '只有坐在这个座位上的终端本人能离座')
  }
  const previous = target.seat
  saveTarget(target, null)
  const where = `${target.business.name}${target.project ? `/${target.project.name}` : ''}`
  seatEvent(
    target,
    `${seatOccupantName(previous)} 离座：${where} 的 ${target.project ? 'Leader' : 'CEO'} 位`,
    previous
  )
  invalidate()
  return { seat: null }
}

export async function assertProjectManager(businessId, caller, remote = false) {
  if (caller.kind === 'owner') {
    return
  }
  const ceo = getBusiness(businessId).ceo
  const terminalAlive =
    ceo?.occupant?.kind !== 'terminal' ||
    (await rpc('terminal.list')).terminals.some((t) => t.handle === ceo.terminal)
  if (!remote && terminalAlive && caller.id && caller.id === seatOccupantId(ceo)) {
    return
  }
  throw apiError(403, 'forbidden', '项目由 CEO 增减')
}

export async function launchCeo(id, body, { claimTerminal } = {}) {
  const key = `ceo:${id}`
  if (launching.has(key)) {
    throw apiError(409, 'business_busy', '业务 CEO 正在启动')
  }
  validateSeatLaunch(body)
  launching.add(key)
  try {
    let business = getBusiness(id)
    const path = canonicalPath(business.workspacePath)
    const listed = await rpc('terminal.list')
    const current = normalizeSeat(business.ceo)
    const existing = listed.terminals.find((t) => t.handle === current?.terminal)
    if (current?.occupant?.kind === 'session' && !body.replace) {
      throw seatOccupied(current, !claimTerminal)
    }
    let terminal
    if (claimTerminal) {
      const claimed = listed.terminals.find((t) => t.handle === claimTerminal)
      if (!claimed || canonicalPath(claimed.worktreePath) !== canonicalPath(path)) {
        throw badRequest(`坐 CEO 位必须在业务根目录 ${path} 的 Agent 终端里`)
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
    if (!terminal) {
      await exitRegionGuard().assertAllowed(body.agent, { cwd: path })
      await ensureRepo(path, business.name)
      const result = await rpc('terminal.create', {
        worktree: `path:${path}`,
        title: `${business.name} · CEO · ${body.agent}`,
        command: agentCommand(body.agent, { ...body, role: 'ceo', business }),
        presentation: 'background'
      })
      terminal = result.terminal.handle
    }
    if (created || claimed) {
      business = updateBusiness(id, { ceo: terminalSeat(terminal, body.agent, body.model) })
      seatEvent(
        { business, path },
        `${body.agent}（${terminal}）坐上 ${business.name} 的 CEO 位`,
        business.ceo
      )
    }
    if (body.prompt?.trim()) {
      if (!created) {
        await rpc('terminal.send', { terminal, text: body.prompt, enter: true, agentPrompt: true })
      }
      const dispatch = recordDispatch({
        ...(created ? { delivery: 'queued' } : {}),
        handle: terminal,
        project: path,
        agent: business.ceo.agent,
        role: 'ceo',
        prompt: body.prompt,
        by: { kind: 'owner', id: 'opc-owner', label: '老板' }
      })
      if (created) {
        void queueCeoPrompt(business, dispatch, invalidate).catch((error) =>
          console.error('CEO 首句状态写入失败', error)
        )
      }
      business = {
        ...business,
        ceo: {
          ...business.ceo,
          state: 'pending',
          activity: body.prompt.split('\n')[0].slice(0, 80)
        }
      }
    }
    return { business, terminal, brief: ceoBrief(business) }
  } finally {
    launching.delete(key)
  }
}
