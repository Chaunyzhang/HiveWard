import { iso } from './api-runtime.mjs'

const present = (event) => (event.ts ? [event] : [])

function gateEvents({ gate, business }) {
  const events = present({
    id: `decision:${gate.id}:created`,
    ts: iso(gate.created_at),
    businessId: business.id,
    kind: 'decision',
    title: `待办产生：${gate.question}`,
    decisionId: gate.id,
    taskId: gate.task_id ?? undefined,
    path: business.workspacePath
  })
  if (gate.status === 'resolved') {
    events.push(
      ...present({
        id: `decision:${gate.id}:resolved`,
        ts: iso(gate.resolved_at),
        businessId: business.id,
        kind: 'decision',
        title: `待办已处理：${gate.question}`,
        detail: `老板选择：${typeof gate.resolution === 'string' ? gate.resolution : JSON.stringify(gate.resolution)}`,
        decisionId: gate.id,
        taskId: gate.task_id ?? undefined,
        path: business.workspacePath
      })
    )
  }
  return events
}

function workerEvents({ dispatch, shown, agent, startedAt, business }) {
  return present({
    id: `worker:${dispatch.dispatchId}:started`,
    ts: startedAt,
    businessId: business.id,
    kind: 'worker',
    title: `Agent 开工：${agent || dispatch.dispatchId}`,
    taskId: dispatch.taskId,
    agent: agent || undefined,
    terminal: shown.terminal?.handle ?? undefined,
    path: business.workspacePath
  })
}

function taskEvents({ task, worker, done, workerReports, business, title }) {
  const events = present({
    id: `task:${task.id}:created`,
    ts: iso(task.created_at),
    businessId: business.id,
    kind: 'task',
    title: `任务创建：${title}`,
    taskId: task.id,
    agent: worker?.agent || undefined,
    terminal: worker?.terminal,
    path: business.workspacePath
  })
  const finishedAt = iso(task.completed_at ?? task.updated_at ?? done?.created_at)
  if (['completed', 'failed'].includes(task.status) && finishedAt) {
    events.push(
      ...present({
        id: `task:${task.id}:${task.status}:${finishedAt}`,
        ts: finishedAt,
        businessId: business.id,
        kind: 'task',
        title: `${task.status === 'completed' ? '任务完成' : '任务失败'}：${title}`,
        taskId: task.id,
        agent: worker?.agent || undefined,
        terminal: worker?.terminal,
        path: business.workspacePath
      })
    )
  }
  for (const report of workerReports ?? (done ? [done] : [])) {
    events.push(
      ...present({
        id: `worker-report:${report.id}`,
        ts: iso(report.created_at),
        businessId: business.id,
        kind: 'worker',
        title: `Agent 汇报：${report.subject || title}`,
        detail: report.body,
        taskId: task.id,
        agent: worker?.agent || undefined,
        terminal: worker?.terminal ?? report.from_handle ?? undefined,
        path: business.workspacePath
      })
    )
  }
  return events
}

function decisionMessageEvents({ message, reply, business }) {
  const events = present({
    id: `decision:${message.id}:created`,
    ts: iso(message.created_at),
    businessId: business.id,
    kind: 'decision',
    title: `待办产生：${message.subject}`,
    detail: message.body,
    decisionId: message.id,
    terminal: message.from_handle ?? undefined,
    agent: business.leaderAgent,
    path: business.workspacePath
  })
  if (reply) {
    events.push(
      ...present({
        id: `decision:${message.id}:resolved`,
        ts: iso(reply.created_at),
        businessId: business.id,
        kind: 'decision',
        title: `待办已处理：${message.subject}`,
        detail: `老板选择：${reply.body}`,
        decisionId: message.id,
        terminal: message.from_handle ?? undefined,
        agent: business.leaderAgent,
        path: business.workspacePath
      })
    )
  }
  return events
}

function dispatchEvents({ dispatch, businessId, decision }) {
  const title = dispatch.prompt.split('\n')[0].slice(0, 80)
  const common = {
    businessId,
    agent: dispatch.liveAgent ?? dispatch.agent ?? undefined,
    terminal: dispatch.handle,
    path: dispatch.project || dispatch.by.cwd || undefined
  }
  const events = present({
    ...common,
    id: `dispatch:${dispatch.id}:created`,
    ts: dispatch.at,
    kind: dispatch.parent ? 'instruction' : 'task',
    title: `${dispatch.parent ? '补充派活' : '派活'}：${title}`,
    detail: dispatch.prompt,
    taskId: dispatch.parent ? dispatch.parent : dispatch.id
  })
  if (dispatch.parent) {
    return events
  }
  if (dispatch.agentObserved || dispatch.status === 'dispatched') {
    events.push(
      ...present({
        ...common,
        id: `dispatch:${dispatch.id}:started`,
        ts: dispatch.agentObservedAt ?? dispatch.updatedAt ?? dispatch.at,
        kind: 'worker',
        title: `Agent 开工：${dispatch.title || dispatch.agent || dispatch.handle}`,
        taskId: dispatch.id
      })
    )
  }
  if (dispatch.report) {
    events.push(
      ...present({
        ...common,
        id: `dispatch:${dispatch.id}:report`,
        ts: dispatch.report.reportedAt ?? dispatch.updatedAt ?? dispatch.at,
        kind: 'worker',
        title: `Agent 汇报：${title}`,
        detail: dispatch.report.summary,
        taskId: dispatch.id
      })
    )
  }
  if (['completed', 'failed'].includes(dispatch.status)) {
    events.push(
      ...present({
        ...common,
        id: `dispatch:${dispatch.id}:${dispatch.status}`,
        ts: dispatch.updatedAt ?? dispatch.report?.reportedAt ?? dispatch.at,
        kind: 'task',
        title: `${dispatch.status === 'completed' ? '任务完成' : '任务失败'}：${title}`,
        detail: dispatch.blockedReason,
        taskId: dispatch.id
      })
    )
  }
  if (decision) {
    events.push(
      ...present({
        ...common,
        id: `decision:${dispatch.id}:created`,
        ts: decision.createdAt,
        kind: 'decision',
        title: `待办产生：${decision.question}`,
        detail: decision.body ?? dispatch.report?.summary,
        decisionId: dispatch.id,
        taskId: dispatch.id
      })
    )
  }
  return events
}

export function timelineEventsFromSources(sources) {
  return [
    ...(sources.gates ?? []).flatMap(gateEvents),
    ...(sources.workers ?? []).flatMap(workerEvents),
    ...(sources.tasks ?? []).flatMap(taskEvents),
    ...(sources.decisionMessages ?? []).flatMap(decisionMessageEvents),
    ...(sources.dispatches ?? []).flatMap(dispatchEvents)
  ]
}
