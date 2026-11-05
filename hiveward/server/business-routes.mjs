import { resolveHivewardDecision } from './hiveward-decisions.mjs'
import {
  assertProjectArchiveable,
  businessProjects,
  createBusinessProject,
  getProject,
  updateProject
} from './business-projects.mjs'
import { launchProjectLeader } from './project-leaders.mjs'
import { launchWorker } from './worker-launch.mjs'
import { resolveDispatcher, dispatcherRpc } from './hiveward-dispatcher.mjs'
import { startWorker } from './worker-start.mjs'
import { disableProjectSchedule, setProjectSchedule } from './project-schedule.mjs'
import { getBusiness, updateBusiness, apiError, badRequest } from './business.mjs'
import { WORKER_START_TIMEOUT_MS } from '../shared/orchestration-budgets.mjs'
import { bounded, rpc, iso } from './api-runtime.mjs'
import { SEAT_AGENTS, terminalScreen } from './business-terminals.mjs'
import { snapshot, invalidate, topology } from './orchestration.mjs'
import { closingWorkers } from './worker-close.mjs'
import { registerProject, removeProject, renameProjectRepo } from './projects.mjs'
import { hivewardWorkerChat } from './hiveward-worker-chat.mjs'
import { businessIdentity, detectProjectIdentity } from './project-identity.mjs'
import {
  appendTimelineEvents,
  latestTimelineEvent,
  listTimeline,
  recentTimelineEvents
} from './timeline.mjs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviewCaller, reviewTask, resumeWorkRecord } from './task-review.mjs'
import { getWorkRecord } from './work-records.mjs'
import { assertProjectManager, claimSeat, launchCeo, leaveSeat } from './seats.mjs'
import { seatSessionChat } from './seat-chat.mjs'
import { personalAgentBotPatch, personalAgentPatch } from './harnesses.mjs'
import { chatImage } from './transcripts.mjs'

const resolving = new Map()
function terminalSeatClaim(req) {
  if (req.headers['x-hiveward-seat-claim'] !== 'terminal') {
    return undefined
  }
  const caller = reviewCaller(req)
  if (caller.kind !== 'agent' || !caller.id) {
    throw apiError(403, 'forbidden', '终端坐座位需要调用者终端身份')
  }
  return caller.id
}
function detail(snapshot, id) {
  const found = snapshot.details.find((d) => d.business.id === id)
  if (!found) {
    throw apiError(404, 'not_found', `业务不存在：${id}`)
  }
  return found
}
function selected(snapshot, url) {
  const id = url.searchParams.get('businessId')
  return id ? [detail(snapshot, id)] : snapshot.details
}
// 登记 / 改名 / 移除后返回的业务摘要：刚改过，还没重新采集，计数先给零
async function stubSummary(b) {
  const identity = await businessIdentity(b)
  return {
    id: b.id,
    name: identity.name,
    nameSource: identity.nameSource,
    logo: identity.logo,
    icon: b.icon,
    status: b.status,
    priority: b.priority,
    workspacePath: b.workspacePath,
    repoId: b.repoId,
    kind: b.kind,
    missing: b.missing,
    personalAgent: b.personalAgent ?? null,
    personalAgentBot: b.personalAgentBot ?? null,
    leader: null,
    ceo: b.ceo ?? null,
    projects: businessProjects(b.id),
    lastEvent: latestTimelineEvent(b.id),
    updatedAt: b.updatedAt,
    counts: {
      objectivesRunning: 0,
      tasksOpen: 0,
      tasksDone: 0,
      workersLive: 0,
      decisionsPending: 0
    }
  }
}

export function businessRoutes(readJson) {
  const routes = [
    [
      'GET',
      /^\/api\/businesses\/([^/]+)\/projects$/,
      async (_req, [id]) => ({ projects: detail(await snapshot(), id).business.projects })
    ],
    [
      'POST',
      /^\/api\/businesses\/([^/]+)\/projects$/,
      async (req, [id], _url, context) => {
        const caller = reviewCaller(req)
        await assertProjectManager(id, caller, context?.isLan)
        await snapshot()
        const body = await readJson(req)
        let project = createBusinessProject(id, body, caller)
        invalidate()
        if (!body.agent) {
          return { project }
        }
        try {
          const launched = await launchProjectLeader(id, project.id, body)
          invalidate()
          return { project: launched.project }
        } catch (e) {
          invalidate()
          return {
            project: getProject(project.id, id),
            leaderError: { code: e.code ?? 'hiveward_error', message: e.message }
          }
        }
      }
    ],
    [
      'PUT',
      /^\/api\/businesses\/([^/]+)\/projects\/([^/]+)\/schedule$/,
      async (req, [id, projectId], _url, context) => {
        const caller = reviewCaller(req)
        await assertProjectManager(id, caller, context?.isLan)
        const project = await setProjectSchedule(getProject(projectId, id), await readJson(req))
        invalidate()
        return { project }
      }
    ],
    [
      'PATCH',
      /^\/api\/businesses\/([^/]+)\/projects\/([^/]+)$/,
      async (req, [id, projectId], _url, context) => {
        const caller = reviewCaller(req)
        await assertProjectManager(id, caller, context?.isLan)
        const current = getProject(projectId, id)
        const { name, status } = await readJson(req)
        if (status === 'archived' && current.status !== 'archived') {
          invalidate()
          assertProjectArchiveable(projectId, (await snapshot()).dispatches)
          await disableProjectSchedule(current)
        }
        const project = updateProject(
          projectId,
          {
            ...(name !== undefined ? { name } : {}),
            ...(status !== undefined ? { status } : {})
          },
          caller
        )
        invalidate()
        return { project }
      }
    ],
    [
      'POST',
      /^\/api\/businesses\/([^/]+)\/projects\/([^/]+)\/leader$/,
      async (req, [id, projectId]) => {
        try {
          return await launchProjectLeader(id, projectId, await readJson(req), {
            claimTerminal: terminalSeatClaim(req)
          })
        } finally {
          invalidate()
        }
      }
    ],
    // 老板在架构图上点「+」直接派下属
    [
      'POST',
      /^\/api\/businesses\/([^/]+)\/workers$/,
      async (req, [id], _url, context) =>
        launchWorker(
          id,
          await readJson(req),
          reviewCaller(req),
          context?.isLan ? context.peerMachineId : context?.localMachineId
        )
    ],
    [
      'POST',
      /^\/api\/businesses\/([^/]+)\/ceo$/,
      async (req, [id]) => {
        try {
          const result = await launchCeo(id, await readJson(req), {
            claimTerminal: terminalSeatClaim(req)
          })
          return { ...result, business: await stubSummary(result.business) }
        } finally {
          invalidate()
        }
      }
    ],
    ['POST', /^\/api\/seats\/claim$/, async (req) => claimSeat(await readJson(req))],
    [
      'POST',
      /^\/api\/seats\/leave$/,
      async (req) => leaveSeat(await readJson(req), reviewCaller(req))
    ],

    [
      'GET',
      /^\/api\/overview$/,
      async () => {
        const s = await snapshot()
        return {
          health: s.health,
          businesses: s.details.map((d) => d.business),
          decisionsPending: s.details.reduce(
            (sum, d) => sum + d.business.counts.decisionsPending,
            0
          ),
          recentEvents: recentTimelineEvents(undefined, 20)
        }
      }
    ],
    [
      'GET',
      /^\/api\/timeline$/,
      async (_req, _params, url) => {
        await snapshot()
        return listTimeline({
          businessId: url.searchParams.get('businessId') ?? undefined,
          projectId: url.searchParams.get('projectId') ?? undefined,
          cursor: url.searchParams.get('cursor') ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
        })
      }
    ],
    ['GET', /^\/api\/businesses\/([^/]+)$/, async (_req, [id]) => detail(await snapshot(), id)],
    // 坐在 CEO / Leader 位上的外部会话（Claude 桌面端等）的对话，只读
    [
      'GET',
      /^\/api\/seats\/([^/]+)\/chat$/,
      async (_req, [nodeId]) => seatSessionChat((await snapshot()).details, nodeId)
    ],
    [
      'GET',
      /^\/api\/topology$/,
      async (_req, _params, url, context) => {
        const machines = context?.members?.() ?? context?.onlineMembers?.() ?? []
        const s = await snapshot()
        const graph = topology(
          selected(s, url),
          s.dispatches,
          !url.searchParams.has('businessId'),
          s.details,
          machines
        )
        // 手动关了、还在撤销期里的下属：架构图上先拿掉，撤销了再回来
        const closing = closingWorkers()
        return closing.size
          ? {
              ...graph,
              nodes: graph.nodes.filter((n) => !(n.kind === 'worker' && closing.has(n.terminal)))
            }
          : graph
      }
    ],
    [
      'GET',
      /^\/api\/tasks$/,
      async (_req, _params, url) => {
        const s = await snapshot()
        const all = [
          ...selected(s, url).flatMap((d) => d.tasks),
          ...(url.searchParams.has('businessId') ? [] : [...s.orphanTasks, ...s.historicalTasks])
        ]
        return all.filter(
          (t) =>
            (!url.searchParams.has('status') || t.status === url.searchParams.get('status')) &&
            (!url.searchParams.has('projectId') ||
              t.projectId === url.searchParams.get('projectId'))
        )
      }
    ],
    [
      'POST',
      /^\/api\/tasks\/([^/]+)\/review$/,
      async (req, [id], _url, context) =>
        reviewTask(id, await readJson(req), reviewCaller(req), {
          remote: context?.isLan,
          peerMachineId: context?.peerMachineId,
          localMachineId: context?.localMachineId
        })
    ],
    [
      'GET',
      /^\/api\/records\/([^/]+)$/,
      async (_req, [id]) => {
        const record = getWorkRecord(id)
        if (!record) {
          throw apiError(404, 'not_found', `工作记录不存在：${id}`)
        }
        return record
      }
    ],
    ['POST', /^\/api\/records\/([^/]+)\/resume$/, async (_req, [id]) => resumeWorkRecord(id)],
    // 对话里的图片（老板贴的图、工具返回的截图），id 由读对话时登记
    ['GET', /^\/api\/chat-images\/([a-f0-9]{32})$/, async (_req, [id]) => chatImage(id)],
    // Agent 用 hiwd web screenshot 存的截图，只开放系统临时目录里 hiveward-shot-<数字>.png 这一种
    [
      'GET',
      /^\/api\/shots\/((?:hiveward|opc)-shot-\d+\.png)$/,
      async (_req, [name]) => ({
        raw: await readFile(join(tmpdir(), name)).catch(() => {
          throw apiError(404, 'not_found', '截图不存在')
        }),
        type: 'image/png'
      })
    ],
    [
      'POST',
      /^\/api\/workers\/start$/,
      async (req, _params, _url, context) => {
        if (context?.isLan) {
          throw apiError(
            409,
            'hiveward_federation_required',
            '跨电脑派活请使用本机 worker-start --on <environment>'
          )
        }
        const body = await readJson(req)
        const caller = reviewCaller(req)
        const result = await startWorker(
          { ...body, from: undefined },
          caller,
          context?.isLan ? context.peerMachineId : context?.localMachineId
        )
        invalidate()
        return result
      }
    ],
    [
      'POST',
      /^\/api\/orchestration\/session$/,
      async (req, _params, _url, context) => {
        const body = await readJson(req)
        return resolveDispatcher(
          reviewCaller(req),
          body.path,
          context?.isLan ? context.peerMachineId : context?.localMachineId
        )
      }
    ],
    [
      'GET',
      /^\/api\/decisions$/,
      async (_req, _params, url) => {
        const s = await snapshot()
        return [
          ...selected(s, url).flatMap((d) => d.decisions),
          ...(url.searchParams.has('businessId') ? [] : s.orphanDecisions)
        ].filter((d) => !url.searchParams.has('state') || d.state === url.searchParams.get('state'))
      }
    ],
    [
      'GET',
      /^\/api\/businesses\/([^/]+)\/logo$/,
      async (_req, [id], url) => {
        const business = getBusiness(id)
        const { logo } = await detectProjectIdentity(business.workspacePath)
        if (!logo) {
          throw apiError(404, 'not_found', '业务没有可识别的 logo')
        }
        const raw = await readFile(logo.path).catch(() => {
          throw apiError(404, 'not_found', '业务 logo 已不存在')
        })
        return {
          raw,
          type: logo.contentType,
          cacheControl: url.searchParams.has('v')
            ? 'public, max-age=31536000, immutable'
            : 'no-store',
          headers: {
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
            'x-content-type-options': 'nosniff'
          }
        }
      }
    ],
    // 登记文件夹是业务：登记目录成引擎项目并补业务记录；目录已是项目时返回已有业务
    [
      'POST',
      /^\/api\/businesses$/,
      async (req) => {
        const body = await readJson(req)
        if (typeof body.path !== 'string' || !body.path.trim()) {
          throw badRequest('path 不能为空')
        }
        if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
          throw badRequest('name 不能为空')
        }
        const b = await registerProject({ path: body.path, name: body.name })
        invalidate()
        return { business: await stubSummary(b) }
      }
    ],
    [
      'PATCH',
      /^\/api\/businesses\/([^/]+)$/,
      async (req, [id]) => {
        const body = await readJson(req)
        getBusiness(id)
        const patch = {}
        if (body.name !== undefined) {
          if (typeof body.name !== 'string' || !body.name.trim()) {
            throw badRequest('name 不能为空')
          }
          patch.name = body.name.trim()
          patch.nameSource = 'user'
        }
        if (body.icon !== undefined) {
          if (typeof body.icon !== 'string') {
            throw badRequest('icon 必须是字符串')
          }
          patch.icon = body.icon
        }
        if (body.status !== undefined) {
          if (!['active', 'paused', 'archived'].includes(body.status)) {
            throw badRequest('status 必须是 active、paused 或 archived')
          }
          patch.status = body.status
        }
        if (body.leaderAgent !== undefined) {
          if (!SEAT_AGENTS.includes(body.leaderAgent)) {
            throw badRequest('leaderAgent 必须为 claude、codex 或 kimi')
          }
          patch.leaderAgent = body.leaderAgent
        }
        if (body.leaderModel !== undefined) {
          if (typeof body.leaderModel !== 'string') {
            throw badRequest('leaderModel 必须是字符串')
          }
          patch.leaderModel = body.leaderModel
        }
        if (body.personalAgent !== undefined) {
          patch.personalAgent = personalAgentPatch(body.personalAgent)
          // 换了一家（或空出来），之前选的那个 Bot 作废
          patch.personalAgentBot = null
        }
        if (body.personalAgentBot !== undefined) {
          patch.personalAgentBot = personalAgentBotPatch(body.personalAgentBot)
        }
        if (!Object.keys(patch).length) {
          throw badRequest('没有要改的字段')
        }
        const updated = updateBusiness(id, patch)
        if (patch.name) {
          await renameProjectRepo(updated, patch.name)
        }
        invalidate()
        return { business: await stubSummary(updated) }
      }
    ],
    // 从引擎移除项目（repo.rm 只取消登记，不删磁盘文件）；业务记录保留，标 removedAt
    [
      'DELETE',
      /^\/api\/businesses\/([^/]+)$/,
      async (_req, [id]) => {
        const b = await removeProject(id)
        invalidate()
        return { business: await stubSummary(b) }
      }
    ],
    [
      'POST',
      /^\/api\/workers\/([^/]+)\/tell$/,
      async (req, [id]) => {
        const { text } = await readJson(req)
        if (typeof text !== 'string' || !text.trim()) {
          throw badRequest('text 不能为空')
        }
        const source = await snapshot()
        const row = source.dispatches.find((dispatch) => dispatch.dispatchId === id)
        if (!row) {
          throw apiError(404, 'not_found', `派单不存在：${id}`)
        }
        const caller = reviewCaller(req)
        if (caller.kind === 'agent' && caller.id !== row.by.id) {
          throw apiError(403, 'forbidden', '只能追问自己派出去的活')
        }
        const result = await dispatcherRpc(row.party, 'orchestration.send', {
          from: row.party.address,
          to: `dispatch:${id}`,
          subject: '派单方消息',
          body: text
        })
        invalidate()
        return result
      }
    ],
    [
      'GET',
      /^\/api\/workers\/([^/]+)\/screen$/,
      async (_req, [id]) => {
        if (id.startsWith('term:')) {
          return terminalScreen(id.slice(5))
        }
        const output = await rpc('orchestration.workerRead', {
          dispatch: id,
          source: 'auto',
          limit: 300
        })
        return {
          ...hivewardWorkerChat(output),
          text: output.terminal?.tail?.join('\n') ?? '',
          capturedAt: new Date().toISOString()
        }
      }
    ],
    [
      'POST',
      /^\/api\/decisions\/([^/]+)\/resolve$/,
      async (req, [id]) => {
        const body = await readJson(req)
        if (typeof body.choice !== 'string' || !body.choice.trim()) {
          throw badRequest('choice 不能为空')
        }
        if (body.note !== undefined && typeof body.note !== 'string') {
          throw badRequest('note 必须是字符串')
        }
        if (body.custom !== undefined && typeof body.custom !== 'boolean') {
          throw badRequest('custom 必须是布尔值')
        }
        if (resolving.has(id)) {
          throw apiError(409, 'decision_busy', '此决定正在提交')
        }
        resolving.set(id, true)
        try {
          invalidate()
          const s = await snapshot()
          const decision = [...s.details.flatMap((d) => d.decisions), ...s.orphanDecisions].find(
            (d) => d.id === id
          )
          if (!decision) {
            throw apiError(404, 'not_found', `待办不存在：${id}`)
          }
          if (decision.state !== 'pending') {
            return decision
          }
          if (!body.custom && decision.options.length && !decision.options.includes(body.choice)) {
            throw badRequest('choice 必须来自 options，或设置 custom=true')
          }
          const result = await resolveHivewardDecision(decision, body, reviewCaller(req))
          const resolvedAt = iso(result.gate?.resolved_at ?? result.message?.created_at)
          invalidate()
          return {
            ...decision,
            state: 'resolved',
            resolution: {
              choice: body.choice,
              note: body.note,
              custom: body.custom === true,
              resolvedAt
            }
          }
        } finally {
          resolving.delete(id)
        }
      }
    ]
  ]
  return routes.map(([method, regex, handler]) => [
    method,
    regex,
    bounded(
      handler,
      method === 'POST' &&
        (regex.test('/api/workers/start') ||
          regex.test('/api/businesses/test/workers') ||
          regex.test('/api/tasks/test/review'))
        ? WORKER_START_TIMEOUT_MS
        : undefined
    )
  ])
}
