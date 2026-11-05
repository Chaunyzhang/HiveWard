import { existsSync } from 'node:fs'
import { apiError, badRequest, getBusiness } from './business.mjs'
import { bindProjectTerminal, getProject, projectPath } from './business-projects.mjs'
import { OWNER_DELIVERY_RULE } from './business-terminals.mjs'
import { exitRegionGuard } from './agent-exit-region.mjs'
import { invalidate } from './orchestration.mjs'
import { rpc } from './api-runtime.mjs'
import { startWorker } from './worker-start.mjs'

// 网页「+」走引擎 worker-start，项目决定目录和归属。
export async function launchWorker(businessId, body, caller, machineId) {
  if (caller.kind !== 'owner') {
    throw apiError(403, 'forbidden', '这是老板在架构图上派活用的；Agent 派下属请用 hiwd new')
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) {
    throw badRequest('要写清楚让它做什么')
  }
  const business = getBusiness(businessId)
  const project = body.projectId === undefined ? null : getProject(body.projectId, businessId)
  if (project && project.status !== 'active') {
    throw badRequest('项目已归档')
  }
  const path = body.on
    ? body.path
    : project
      ? projectPath(business, project.dir)
      : business.workspacePath
  if (body.on && (typeof path !== 'string' || !path)) {
    throw badRequest('跨环境派活需要目标 path')
  }
  if (!body.on && !existsSync(path)) {
    throw badRequest(`目录不存在：${path}`)
  }
  if (!body.on) {
    await exitRegionGuard().assertAllowed(body.agent, { cwd: path })
  }
  if (body.coordinator !== undefined && !['owner', 'ceo', 'leader'].includes(body.coordinator)) {
    throw badRequest('coordinator 必须为 owner、ceo 或 leader')
  }
  const seat =
    body.coordinator === 'leader'
      ? project?.leader?.terminal
      : body.coordinator === 'ceo'
        ? business.ceo?.terminal
        : undefined
  // 座位终端关了（离线）就记在老板名下派：交活照样由老板复核，不拿关掉的终端去派单
  const from = seat && (await seatTerminalLive(seat)) ? seat : undefined
  const started = await startWorker(
    {
      ...body,
      path,
      prompt: `${prompt}\n\n（HiveWard：${OWNER_DELIVERY_RULE}）`,
      from,
      dispatcherPath: business.workspacePath
    },
    caller,
    machineId
  )
  if (project) {
    bindProjectTerminal(started.terminal, project.id)
  }
  invalidate()
  return started
}

async function seatTerminalLive(handle) {
  const { terminals } = await rpc('terminal.list')
  return terminals.some((t) => t.handle === handle)
}
