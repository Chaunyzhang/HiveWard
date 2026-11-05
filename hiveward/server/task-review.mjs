import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { exitRegionGuard } from './agent-exit-region.mjs'
import { ensureRepo, rpc } from './api-runtime.mjs'
import { apiError, badRequest } from './business.mjs'
import { bindProjectTerminal, getProject } from './business-projects.mjs'
import { FULL_ACCESS, agentCommand, locateTerminalSession } from './business-terminals.mjs'
import { dispatcherRpc } from './hiveward-dispatcher.mjs'
import { REWORK_SUBJECT, dispatchTask } from './dispatches.mjs'
import { invalidate, snapshot } from './orchestration.mjs'
import { appendTimelineEvents } from './timeline.mjs'
import { transcriptSessionId } from './transcripts.mjs'
import { getWorkRecord, saveWorkRecord } from './work-records.mjs'

const reviewing = new Set()
const OWNER_REVIEWER = { kind: 'owner', id: 'hiveward-owner', label: '老板' }

export function reviewCaller(req) {
  if (req.headers['x-hiveward-caller'] !== 'agent') {
    return OWNER_REVIEWER
  }
  const id = req.headers['x-hiveward-dispatcher-id']
  if (typeof id !== 'string') {
    return { kind: 'agent', id: '', label: 'Agent' }
  }
  try {
    return {
      kind: 'agent',
      id: decodeURIComponent(id),
      label: decodeURIComponent(req.headers['x-hiveward-dispatcher-label'] ?? 'Agent'),
      sourceKind: req.headers['x-hiveward-dispatcher-kind'] ?? 'cli',
      cwd: req.headers['x-hiveward-dispatcher-cwd']
        ? decodeURIComponent(req.headers['x-hiveward-dispatcher-cwd'])
        : undefined
    }
  } catch {
    return { kind: 'agent', id: '', label: 'Agent' }
  }
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

export async function reviewTask(
  id,
  body,
  caller,
  { remote = false, peerMachineId, localMachineId } = {}
) {
  if (!['accept', 'rework'].includes(body.verdict)) {
    throw badRequest('verdict 必须为 accept 或 rework')
  }
  if (body.note !== undefined && typeof body.note !== 'string') {
    throw badRequest('note 必须是字符串')
  }
  if (body.verdict === 'rework' && !body.note?.trim()) {
    throw badRequest('打回必须填写复核意见')
  }
  if (reviewing.has(id)) {
    throw apiError(409, 'review_busy', '这条任务正在复核')
  }
  reviewing.add(id)
  try {
    invalidate()
    const source = await snapshot()
    const row = source.dispatches.find((d) => d.id === id)
    if (!row) {
      throw apiError(404, 'not_found', `任务不存在：${id}`)
    }
    if (caller.kind === 'agent' && (!caller.id || caller.id !== row.by.id)) {
      throw apiError(403, 'forbidden', '只能复核自己派出去的活')
    }
    if (caller.kind === 'agent') {
      const originAllowed = remote
        ? !!peerMachineId && row.by.machineId === peerMachineId
        : !row.by.machineId || row.by.machineId === localMachineId
      if (!originAllowed) {
        throw apiError(403, 'forbidden', '只能由原派单电脑上的原派单方复核')
      }
    }
    if (!row.report || row.review?.state !== 'awaiting') {
      throw apiError(409, 'review_not_awaiting', '等下属报 worker_done 后再复核')
    }
    const task = [...source.details.flatMap((d) => d.tasks), ...source.orphanTasks].find(
      (t) => t.id === id
    )
    const reviewer =
      caller.kind === 'owner'
        ? OWNER_REVIEWER
        : { kind: 'agent', id: caller.id, label: row.by.label }
    if (body.verdict === 'rework') {
      const receipt = await dispatcherRpc(row.party, 'orchestration.send', {
        from: row.party.address,
        to: `dispatch:${row.dispatchId}`,
        subject: REWORK_SUBJECT,
        body: body.note
      })
      invalidate()
      return { task, followUp: receipt }
    }
    // worker_done 已结算 Task；网页只保留老板的复核记录，释放规则由引擎裁决。
    const resume = await resumableSession(row)
    const release = await rpc('orchestration.workerRelease', { dispatch: row.dispatchId })
    const acceptedAt = new Date().toISOString()
    // heartbeat 在原生邮箱里直接存成已处理：复核记录留档，但不会变成复核人自己的未读。
    // 顶层不能带 dispatchId：带了引擎就当成下属自己的心跳，要求下属进程本人发，老板发的会被拒收。
    await dispatcherRpc(row.party, 'orchestration.send', {
      from: row.party.address,
      to: `run:${row.runId}`,
      type: 'heartbeat',
      subject: '复核通过',
      body: body.note ?? '复核通过',
      payload: JSON.stringify({
        hivewardReview: {
          taskId: id,
          dispatchId: row.dispatchId,
          verdict: 'accept',
          reviewedBy: reviewer,
          acceptedAt
        }
      })
    })
    const record = saveWorkRecord({
      id: `wr_${id}`,
      taskId: id,
      round: 1,
      businessId: task.businessId || undefined,
      projectId: task.projectId,
      title: task.title,
      prompt: row.prompt,
      summary: row.report.summary,
      agent: row.agent,
      dispatchedBy: row.by,
      reviewedBy: reviewer,
      startedAt: row.at,
      finishedAt: row.report.reportedAt,
      acceptedAt,
      reworks: 0,
      resume
    })
    appendTimelineEvents({
      id: `record:${record.id}`,
      ts: record.acceptedAt,
      businessId: record.businessId,
      projectId: record.projectId,
      kind: 'record',
      title: `工作记录：${record.title}`,
      detail: record.summary.slice(0, 200),
      agent: record.agent,
      taskId: id,
      recordId: record.id
    })
    invalidate()
    return {
      task: dispatchTask(
        {
          ...row,
          review: { ...row.review, state: 'accepted', by: reviewer, at: record.acceptedAt }
        },
        task.businessId
      ),
      record,
      release
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
  if (!resume || !Object.hasOwn(FULL_ACCESS, resume.agent) || !resume.sessionId || !resume.cwd) {
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
