import { queueLeaderPrompt } from './leader-prompt-delivery.mjs'
import { invalidate } from './orchestration.mjs'
import { getBusiness, badRequest, apiError } from './business.mjs'
import {
  getProject,
  updateProject,
  projectPath,
  bindProjectTerminal
} from './business-projects.mjs'
import { rpc, ensureRepo } from './api-runtime.mjs'
import { FULL_ACCESS, agentCommand, agentModel, observeTerminal } from './business-terminals.mjs'
import { exitRegionGuard } from './agent-exit-region.mjs'
import { recordDispatch } from './dispatches.mjs'
import { appendTimelineEvents } from './timeline.mjs'

const launching = new Set()
export async function launchProjectLeader(businessId, id, body) {
  if (launching.has(id)) {
    throw apiError(409, 'project_busy', '项目 Leader Agent 正在启动')
  }
  if (!Object.hasOwn(FULL_ACCESS, body.agent)) {
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
  launching.add(id)
  try {
    let project = getProject(id, businessId)
    if (project.status !== 'active') {
      throw badRequest('项目已归档')
    }
    const business = getBusiness(businessId)
    const path = projectPath(business, project.dir)
    const listed = await rpc('terminal.list')
    const existing = listed.terminals.find((t) => t.handle === project.leader?.terminal)
    const observed = existing && (await observeTerminal(existing))
    let terminal = observed && !observed.exitedToShell && !body.replace ? existing.handle : null
    const created = !terminal
    if (!terminal) {
      await exitRegionGuard().assertAllowed(body.agent, { cwd: path })
      await ensureRepo(path)
      const result = await rpc('terminal.create', {
        worktree: `path:${path}`,
        title: `${project.name} · ${body.agent}`,
        command: agentCommand(body.agent, { ...body, role: 'leader', project, business }),
        presentation: 'background'
      })
      terminal = result.terminal.handle
      project = updateProject(id, {
        path,
        leader: {
          terminal,
          agent: body.agent,
          model: agentModel(body.agent, body.model),
          liveness: 'live',
          state: 'idle',
          startedAt: new Date().toISOString()
        }
      })
      bindProjectTerminal(terminal, id)
      appendTimelineEvents({
        id: `project-leader:${id}:${terminal}`,
        ts: project.updatedAt,
        businessId,
        projectId: id,
        kind: 'leader',
        title: `开 Leader Agent：${project.name}`,
        agent: body.agent,
        terminal,
        path
      })
    }
    if (body.prompt?.trim()) {
      if (!created) {
        await rpc('terminal.send', { terminal, text: body.prompt, enter: true, agentPrompt: true })
      }
      const dispatch = recordDispatch({
        ...(created ? { delivery: 'queued' } : {}),
        handle: terminal,
        project: path,
        projectId: id,
        agent: project.leader.agent,
        role: 'leader',
        prompt: body.prompt,
        by: { kind: 'owner', id: 'opc-owner', label: '老板' }
      })
      if (created) {
        void queueLeaderPrompt(project, dispatch, invalidate).catch((error) =>
          console.error('Leader Agent 首句状态写入失败', error)
        )
      }
      project = {
        ...project,
        leader: {
          ...project.leader,
          state: 'pending',
          activity: body.prompt.split('\n')[0].slice(0, 80)
        }
      }
    }
    return { project, terminal }
  } finally {
    launching.delete(id)
  }
}
