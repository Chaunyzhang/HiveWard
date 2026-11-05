import { businessProjects, updateProject } from './business-projects.mjs'
import { badRequest } from './business.mjs'
import { rpc, iso, ensureRepo } from './api-runtime.mjs'
import { invalidate } from './orchestration.mjs'
import { SEAT_AGENTS } from './business-terminals.mjs'

// 旧分钟间隔由原生 recurrence 执行，保留原来的起点和频率。
export function hivewardScheduleRule(everyMinutes) {
  if (!Number.isInteger(everyMinutes) || everyMinutes < 10 || everyMinutes > 1440) {
    throw badRequest('everyMinutes 必须是 10–1440 的整数')
  }
  return `FREQ=MINUTELY;INTERVAL=${everyMinutes}`
}

export async function projectScheduleProjection(project, call = rpc) {
  if (!project.schedule?.automationId) {
    return project
  }
  const { automation } = await call('automation.show', { id: project.schedule.automationId })
  return {
    ...project,
    schedule: {
      automationId: automation.id,
      enabled: automation.enabled,
      trigger: 'timer',
      rrule: automation.rrule,
      dtstart: automation.dtstart,
      timezone: automation.timezone,
      agentId: automation.agentId ?? undefined,
      agentRequired: !automation.agentId,
      message: automation.prompt,
      ...(automation.lastRunAt ? { lastRunAt: iso(automation.lastRunAt) } : {}),
      ...(automation.enabled ? { nextRunAt: iso(automation.nextRunAt) } : {})
    }
  }
}

export async function setProjectSchedule(project, body, now = Date.now(), call = rpc) {
  if (!body || typeof body.enabled !== 'boolean') {
    throw badRequest('enabled 必须是布尔值')
  }
  if (body.trigger !== undefined && body.trigger !== 'timer') {
    throw badRequest('目前只支持 timer 定时巡检')
  }
  if (project.status !== 'active' && body.enabled) {
    throw badRequest('归档的项目不能开定时巡检')
  }
  if (
    typeof body.message !== 'string' ||
    !body.message.trim() ||
    body.message.trim().length > 2000
  ) {
    throw badRequest('message 必须为 1–2000 字')
  }
  const rrule = body.rrule ?? hivewardScheduleRule(body.everyMinutes)
  const dtstart =
    body.dtstart ??
    (body.rrule
      ? now
      : Date.parse(project.schedule?.nextRunAt ?? '') || now + body.everyMinutes * 60_000)
  const agentId =
    body.agentId ?? (SEAT_AGENTS.includes(project.leader?.agent) ? project.leader.agent : null)
  const fields = {
    name: `HiveWard · ${project.name}`,
    prompt: body.message.trim(),
    agentId: agentId ?? null,
    workspace: `path:${project.path}`,
    workspaceMode: 'existing',
    rrule,
    dtstart,
    enabled: body.enabled && !!agentId,
    ...(body.timezone ? { timezone: body.timezone } : {})
  }
  await ensureRepo(project.path, undefined, call)
  const id = project.schedule?.automationId
  if (id) {
    const { owner } = await call('automation.show', { id })
    await call('automation.update', {
      id,
      updates: fields,
      ...(owner ? { expectedOwner: owner } : {})
    })
  } else {
    const { automation } = await call('automation.create', {
      ...fields,
      creationKey: `hiveward-project-schedule:${project.id}`
    })
    updateProject(project.id, { schedule: { automationId: automation.id } })
  }
  const saved = businessProjects().find((p) => p.id === project.id)
  return projectScheduleProjection(saved, call)
}

export async function disableProjectSchedule(project, call = rpc) {
  const id = project.schedule?.automationId
  if (!id) {
    return
  }
  const { owner } = await call('automation.show', { id })
  await call('automation.update', {
    id,
    updates: { enabled: false },
    ...(owner ? { expectedOwner: owner } : {})
  })
}

// 启动时一次性迁移旧设置；计时、重启恢复和派活均由引擎 automations 负责。
export function createProjectScheduleService({ call = rpc, onChange = invalidate } = {}) {
  return {
    async start() {
      for (const project of businessProjects()) {
        if (project.schedule && !project.schedule.automationId) {
          await setProjectSchedule(project, project.schedule, Date.now(), call)
        }
      }
      onChange()
    },
    close() {}
  }
}
