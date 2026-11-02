import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { exitRegionGuard } from './agent-exit-region.mjs'
import { ensureRepo, rpc } from './api-runtime.mjs'
import { apiError, badRequest } from './business.mjs'
import { bindProjectTerminal, businessProjects, getProject } from './business-projects.mjs'
import { agentCommand, locateTerminalSession } from './business-terminals.mjs'
import {
  dispatchTask,
  dispatches,
  markDispatchAccepted,
  markDispatchRework
} from './dispatches.mjs'
import { invalidate, snapshot } from './orchestration.mjs'
import { appendTimelineEvents } from './timeline.mjs'
import { transcriptSessionId } from './transcripts.mjs'
import { getWorkRecord, saveWorkRecord } from './work-records.mjs'

const reviewing = new Map()
const OWNER_REVIEWER = { kind: 'owner', id: 'opc-owner', label: '老板' }
const CLOSED_ERRORS = new Set([
  'terminal_not_found',
  'terminal_handle_stale',
  'terminal_not_running'
])

export function reviewCaller(req) {
  if (req.headers['x-opc-caller'] !== 'agent') {
    return OWNER_REVIEWER
  }
  const id = req.headers['x-opc-dispatcher-id']
  if (typeof id !== 'string') {
    return { kind: 'agent', id: '', label: 'Agent' }
  }
  try {
    return { kind: 'agent', id: decodeURIComponent(id), label: 'Agent' }
  } catch {
    return { kind: 'agent', id: '', label: 'Agent' }
  }
}

function taskFrom(s, id) {
  return [...s.details.flatMap((detail) => detail.tasks), ...s.orphanTasks].find(
    (task) => task.id === id
  )
}

function reviewedBy(caller, dispatch) {
  return caller.kind === 'owner'
    ? OWNER_REVIEWER
    : { kind: 'agent', id: caller.id, label: dispatch.by.label }
}

async function resumableSession(dispatch) {
  try {
    const session = await locateTerminalSession(dispatch.handle)
    const sessionId = transcriptSessionId(session.agent, session.path)
    const cwd = session.cwd || dispatch.project
    return session.agent && sessionId && cwd ? { agent: session.agent, sessionId, cwd } : undefined
  } catch {
    return undefined
  }
}

function unresolved(dispatch) {
  return (
    !['completed', 'failed'].includes(dispatch.status) ||
    ['awaiting', 'rework'].includes(dispatch.review?.state)
  )
}

function shouldClose(dispatch) {
  if (
    dispatch.role === 'leader' ||
    businessProjects().some((project) => project.leader?.terminal === dispatch.handle)
  ) {
    return false
  }
  return !dispatches().some(
    (other) =>
      other.id !== dispatch.id &&
      !other.parent &&
      other.handle === dispatch.handle &&
      unresolved(other)
  )
}

function workRecord(dispatch, task, reviewer, acceptedAt, resume) {
  return {
    id: `wr_${dispatch.id}`,
    taskId: dispatch.id,
    businessId: task.businessId || undefined,
    projectId: dispatch.projectId || task.projectId || undefined,
    title: task.title,
    prompt: dispatch.prompt,
    summary: dispatch.report?.summary ?? '',
    agent: dispatch.agent ?? undefined,
    dispatchedBy: {
      kind: dispatch.by.kind,
      id: dispatch.by.id,
      label: dispatch.by.label
    },
    reviewedBy: reviewer,
    startedAt: dispatch.at,
    finishedAt: dispatch.report?.reportedAt ?? dispatch.updatedAt ?? dispatch.at,
    acceptedAt,
    reworks: Math.max(0, dispatch.review.round - 1),
    resume
  }
}

export async function reviewTask(id, body, caller, { remote = false } = {}) {
  if (!['accept', 'rework'].includes(body.verdict)) {
    throw badRequest('verdict 必须为 accept 或 rework')
  }
  if (body.note !== undefined && typeof body.note !== 'string') {
    throw badRequest('note 必须是字符串')
  }
  if (body.verdict === 'rework' && !body.note?.trim()) {
    throw badRequest('打回必须填写复核意见')
  }
  if (caller.kind === 'agent' && (!caller.id || remote)) {
    throw apiError(403, 'forbidden', 'Agent 不能跨电脑复核，且必须带调用者身份')
  }
  if (reviewing.has(id)) {
    throw apiError(409, 'review_busy', '这条派单正在复核')
  }
  reviewing.set(id, true)
  try {
    invalidate()
    const s = await snapshot()
    const dispatch = s.dispatches.find((row) => row.id === id && !row.parent)
    const task = taskFrom(s, id)
    if (!dispatch || !task) {
      throw apiError(404, 'not_found', `派单不存在：${id}`)
    }
    if (caller.kind === 'agent' && dispatch.by.id !== caller.id) {
      throw apiError(403, 'forbidden', '只能复核自己派出去的活')
    }
    if (dispatch.review?.state !== 'awaiting') {
      throw apiError(409, 'review_not_awaiting', '这条派单不在待复核状态')
    }
    const reviewer = reviewedBy(caller, dispatch)
    const followUps = s.dispatches.filter((row) => row.parent === id)
    if (body.verdict === 'rework') {
      const text = `复核没通过：${body.note}`
      await rpc('terminal.send', {
        terminal: dispatch.handle,
        text,
        enter: true,
        agentPrompt: true
      })
      const updated = markDispatchRework(id, body.note, reviewer)
      invalidate()
      return {
        task: dispatchTask({ ...updated, alive: dispatch.alive }, task.businessId, followUps)
      }
    }

    const resume = await resumableSession(dispatch)
    const record = saveWorkRecord(
      workRecord(dispatch, task, reviewer, new Date().toISOString(), resume)
    )
    appendTimelineEvents({
      id: `record:${record.id}`,
      ts: record.acceptedAt,
      businessId: record.businessId,
      projectId: record.projectId,
      kind: 'record',
      title: `工作记录：${record.title}`,
      detail: record.summary.slice(0, 200),
      agent: record.agent,
      taskId: record.taskId,
      recordId: record.id
    })

    let alive = dispatch.alive === true
    let closeError
    if (alive && shouldClose(dispatch)) {
      try {
        await rpc('terminal.close', { terminal: dispatch.handle })
        alive = false
      } catch (error) {
        if (CLOSED_ERRORS.has(error.code)) {
          alive = false
        } else {
          closeError = error.message
        }
      }
    }
    const updated = markDispatchAccepted(id, record.reviewedBy, record.acceptedAt, body.note)
    invalidate()
    return {
      task: dispatchTask({ ...updated, alive }, task.businessId, followUps),
      record,
      closeError
    }
  } finally {
    reviewing.delete(id)
  }
}

export async function resumeWorkRecord(id) {
  const record = getWorkRecord(id)
  if (!record) {
    throw apiError(404, 'not_found', `工作记录不存在：${id}`)
  }
  const resume = record.resume
  if (
    !resume ||
    !['claude', 'codex', 'kimi'].includes(resume.agent) ||
    !resume.sessionId ||
    !resume.cwd
  ) {
    throw apiError(409, 'resume_unavailable', '这条工作记录没有可恢复的会话')
  }
  let directory = false
  try {
    directory = statSync(resume.cwd).isDirectory()
  } catch {
    // Missing cwd is reported as an unavailable resume below.
  }
  if (!directory) {
    throw apiError(409, 'resume_unavailable', `原工作目录不存在：${resume.cwd}`)
  }
  const project = record.projectId ? getProject(record.projectId) : null
  await exitRegionGuard().assertAllowed(resume.agent, { cwd: resume.cwd })
  const repo = await ensureRepo(resume.cwd)
  const result = await rpc('terminal.create', {
    worktree: `path:${repo.path}`,
    title: `工作记录：${record.title}`,
    command: agentCommand(resume.agent, { resume: resume.sessionId }),
    presentation: 'background'
  })
  const terminal = result.terminal.handle
  if (project) {
    bindProjectTerminal(terminal, project.id)
  }
  appendTimelineEvents({
    id: `record:${record.id}:resume:${randomUUID()}`,
    ts: new Date().toISOString(),
    businessId: record.businessId,
    projectId: record.projectId,
    kind: 'record',
    title: `重新打开工作记录：${record.title}`,
    agent: resume.agent,
    taskId: record.taskId,
    recordId: record.id,
    terminal,
    path: resume.cwd
  })
  invalidate()
  return { terminal }
}
