import { hivewardEnvironment } from '../shared/environment.mjs'
import { createServer as createHttpsServer } from 'node:https'
import { launchProjectLeader } from './project-leaders.mjs'
import { createFileService } from './files.mjs'
import { createClipboardService } from './clipboard.mjs'
import { invalidate, markAirborneLaunch, snapshot } from './orchestration.mjs'
import { getProject, projectPath, bindProjectTerminal } from './business-projects.mjs'
import { getBusiness, workspacePath } from './business.mjs'
import {
  createExitRegionGuard,
  configureExitRegionGuard,
  exitRegionGuard
} from './agent-exit-region.mjs'
import { createExitIp } from './exit-ip.mjs'
import { createMachineModel } from './machine-model.mjs'
import { installTerminalWebSockets } from './terminal-websocket.mjs'
import { createMcpService } from './mcp-shares.mjs'
import { closingWorkers, createWorkerCloser } from './worker-close.mjs'
import { droppedQueuedMessages } from './model-error-stop.mjs'
import {
  createQuotaResumer,
  quotaAlerts,
  quotaSettings,
  quotaStopped,
  saveQuotaSettings
} from './quota-stop.mjs'
import { dispatches, observeDispatches, recordTerminalTell } from './dispatches.mjs'
import { createMcpWebSocketHandler } from './mcp-websocket.mjs'
// HiveWard ↔ HiveWard 桥：本机端口 + 需要配对令牌的局域网端口。
// 这是后端的第一块（终端现场）；业务 / 任务 / 待办等接口由后端正式实现时并入。
// 启动：node server/hiveward-bridge.mjs   （默认 127.0.0.1:47615，网页 dev 服务器把 /api 代理到这里）
import { businessRoutes } from './business-routes.mjs'
import { workspaceChangesRoutes } from './workspace-changes.mjs'
import { sessionPlanRoutes } from './session-plan.mjs'
import { sessionAwakeRoutes } from './session-awake.mjs'
import { checkGrokBotForward, grokBotRoutes } from './grok-bots.mjs'
import { harnessRoutes } from './harnesses.mjs'
import { agentCommand, terminalChat } from './business-terminals.mjs'
import { ensureRepo, iso } from './api-runtime.mjs'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { createLan } from './lan.mjs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { call, HiveWardUnavailable } from './hiveward-client.mjs'
import { imagePasteText, MAX_IMAGES, saveTerminalImage } from './terminal-image-paste.mjs'
import { agentOfPid } from './transcripts.mjs'
import { createProjectScheduleService } from './project-schedule.mjs'
import { createAutomationRunIdleCloser } from './automation-run-idle-close.mjs'
import { spinningOnScreen } from './terminal-spinning.mjs'
import { resolveDispatcher } from './hiveward-dispatcher.mjs'
import { createAgentWakeService, formatWakeMessages } from './agent-wake.mjs'
import { reviewCaller } from './task-review.mjs'

// 冷门端口：8787 和 Grok Bot 的 MCP 登录回调（localhost:8787/callback）撞了
const PORT = Number(hivewardEnvironment.HIVEWARD_PORT ?? 47615)
const AGENTS = new Set(['claude', 'codex', 'kimi', 'opencode'])

// 终端画面里的 ANSI 控制符去掉，网页按纯文本等宽显示
const stripAnsi = (s) =>
  s.replace(
    // oxlint-disable-next-line no-control-regex -- 去掉终端转义序列，本来就要匹配 ESC 控制字符
    /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g,
    ''
  )

const routes = [
  // 所有终端（HiveWard 侧栏里能看到的那些）
  [
    'GET',
    /^\/api\/hiveward\/terminals$/,
    async () => {
      const closing = closingWorkers()
      // 手动关了、还在撤销期里的下属：当它已经关了
      const r = await call('terminal.list', {}).then((x) => ({
        ...x,
        terminals: x.terminals.filter((t) => !closing.has(t.handle))
      }))
      // 引擎自己认出的 Agent（agentIdentity）优先，认不出再看前台进程
      const agents = await Promise.all(
        r.terminals.map((t) => knownAgent(t.agentIdentity) ?? foregroundAgent(t.handle))
      )
      const started = await Promise.all(
        r.terminals.map((t, i) => (agents[i] ? agentStartedAt(t.handle) : forgetStart(t.handle)))
      )
      // 跑着 Agent 的终端再问一句它在干活还是在等，后台命令数也一起带给网页
      const statuses = await Promise.all(
        r.terminals.map((t, i) =>
          agents[i]
            ? call('terminal.agentStatus', { terminal: t.handle }).then(
                (s) => s?.agentStatus ?? null,
                () => null
              )
            : null
        )
      )
      const shown = statuses.map((status) => status?.status)
      return {
        terminals: r.terminals.map((t, i) => ({
          agent: agents[i],
          status: shown[i] ?? undefined,
          backgroundCommands:
            statuses[i]?.backgroundCommands > 0 ? statuses[i].backgroundCommands : undefined,
          handle: t.handle,
          title: t.title,
          project: t.worktreePath,
          branch: t.branch || undefined,
          connected: t.connected,
          writable: t.writable,
          lastOutputAt: t.lastOutputAt ?? undefined,
          startedAt: started[i],
          preview:
            stripAnsi(t.preview ?? '')
              .trim()
              .split('\n')
              .at(-1) ?? ''
        }))
      }
    }
  ],
  // HiveWard 里登记过的项目（开新 Agent 时选在哪个项目里）
  [
    'GET',
    /^\/api\/hiveward\/projects$/,
    async () => {
      const r = await call('repo.list', {})
      return {
        projects: r.repos.map((p) => ({
          path: p.path,
          name: p.displayName ?? p.path.split(/[/\\]/).at(-1)
        }))
      }
    }
  ],
  // 当前整屏 + Agent 状态
  [
    'GET',
    /^\/api\/hiveward\/terminals\/([^/]+)\/screen$/,
    async (_req, [handle]) => {
      const [read, status, processState] = await Promise.all([
        call('terminal.read', { terminal: handle, screen: true }),
        call('terminal.agentStatus', { terminal: handle }).catch(() => null),
        call('terminal.inspectProcess', { terminal: handle }).catch(() => null)
      ])
      const a = status?.agentStatus
      const exitedToShell =
        processState?.process?.hasChildProcesses === false &&
        processState?.process?.foregroundProcess === null
      const running = !exitedToShell && a?.isRunningAgent
      const dropped = running ? droppedQueuedMessages(read.terminal.tail.join('\n')) : []
      return {
        text: stripAnsi(read.terminal.tail.join('\n')),
        capturedAt: new Date().toISOString(),
        running: read.terminal.status === 'running',
        // Kimi 不报状态：和列表一样看屏幕上有没有转圈（它的转圈行在底栏上面，多看几行）
        agent:
          !exitedToShell && a?.isRunningAgent
            ? (a.status ?? (spinningOnScreen(read.terminal.tail) ? 'working' : 'unknown'))
            : null,
        backgroundCommands:
          !exitedToShell && a?.isRunningAgent && a.backgroundCommands > 0
            ? a.backgroundCommands
            : undefined,
        errorStop: dispatches().findLast((d) => d.handle === handle)?.errorStop,
        dropped: dropped.length ? dropped : undefined
      }
    }
  ],
  // 对话视图：读终端里 Agent 自己的对话记录，统一成消息列表
  [
    'GET',
    /^\/api\/hiveward\/terminals\/([^/]+)\/chat$/,
    async (_req, [handle]) => terminalChat(handle)
  ],
  // 往终端里打字；interrupt=true 相当于按 Ctrl-C
  [
    'POST',
    /^\/api\/hiveward\/terminals\/([^/]+)\/send$/,
    async (req, [handle], _url, context) => {
      const body = await readJson(req)
      if (body.interrupt) {
        return call('terminal.send', { terminal: handle, interrupt: true })
      }
      const images = body.images ?? []
      if (!Array.isArray(images) || images.length > MAX_IMAGES) {
        throw badRequest(`一次最多贴 ${MAX_IMAGES} 张图`)
      }
      if (typeof body.text !== 'string' || (!body.text && !images.length)) {
        throw badRequest('text 不能为空')
      }
      const dispatch = dispatches().findLast((d) => d.handle === handle)
      const caller = reviewCaller(req)
      if (images.length && caller.kind !== 'owner') {
        throw badRequest('图只能老板在对话框里贴')
      }
      // 贴的图先一张张当作粘贴打进去（像在终端里粘贴截图），等 Agent 认成附件再打字回车
      const pastes = images.map((path) => imagePasteText(path))
      for (const paste of pastes) {
        await call('terminal.send', { terminal: handle, text: `${paste} `, enter: false })
      }
      if (pastes.length) {
        await new Promise((done) => setTimeout(done, IMAGE_ATTACH_MS))
      }
      // 老板说话像自己在终端里打字一样直接送进去，不开单（派单前言也写明：用户直接说的话就是新的活）；
      // Agent 对 Agent 说话才走编排，交过活的在原单上开下一张
      if (body.agentPrompt === true && dispatch && caller.kind !== 'owner') {
        const party = await resolveDispatcher(
          caller,
          dispatch.project,
          context?.isLan ? context.peerMachineId : context?.localMachineId
        )
        return recordTerminalTell(handle, body.text, party)
      }
      const result = await call('terminal.send', {
        terminal: handle,
        ...(body.text ? { text: body.text } : {}),
        enter: body.enter !== false,
        agentPrompt: body.agentPrompt === true ? true : undefined
      })
      return result
    }
  ],
  // 对话框里贴的图：存成临时文件，返回路径；发送时带在 images 里
  ['POST', /^\/api\/hiveward\/images$/, async (req) => saveTerminalImage(req)],
  // Agent 停在选择菜单上（计划要批准等）：选第 n 项。先确认菜单还在再按键
  // 在某个项目里开一个终端并启动 Agent
  [
    'POST',
    /^\/api\/hiveward\/terminals$/,
    async (req, _params, _url, context) => {
      const body = await readJson(req)
      const project = body.projectId ? getProject(body.projectId) : null
      if (project && project.status !== 'active') {
        throw badRequest('项目已归档')
      }
      const business = project ? getBusiness(project.businessId) : null
      if (project && body.role === 'leader') {
        try {
          const launched = await launchProjectLeader(project.businessId, project.id, {
            agent: body.agent,
            model: body.model
          })
          return { handle: launched.terminal }
        } finally {
          invalidate()
        }
      }
      if (project) {
        body.project = projectPath(business, project.dir)
      }
      if (!body.project) {
        throw badRequest('缺少 project')
      }
      body.project = workspacePath(body.project)
      if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
        throw badRequest('model 必须是非空字符串')
      }
      if (body.agent && !AGENTS.has(body.agent)) {
        throw badRequest(`不支持的 agent：${body.agent}`)
      }
      if (!existsSync(body.project)) {
        throw badRequest(`目录不存在：${body.project}`)
      }
      if (body.agent) {
        await exitRegionGuard().assertAllowed(body.agent, { cwd: body.project })
      }
      const repo = await ensureRepo(body.project)
      const r = await call('terminal.create', {
        worktree: `path:${repo.path}`,
        title: body.title || body.agent || 'Terminal',
        command: body.agent
          ? agentCommand(body.agent, { role: body.role, model: body.model, project, business })
          : undefined,
        presentation: 'background'
      })
      if (project) {
        bindProjectTerminal(r.terminal.handle, project.id)
      }
      if (context?.isLan && body.role !== 'leader') {
        markAirborneLaunch(r.terminal.handle)
      }
      invalidate()
      return { handle: r.terminal.handle }
    }
  ],
  [
    'POST',
    /^\/api\/hiveward\/terminals\/([^/]+)\/close$/,
    async (_req, [handle]) => {
      const source = await snapshot()
      const worker = source.dispatches.findLast((d) => d.handle === handle)
      if (worker) {
        return call(worker.report ? 'orchestration.workerRelease' : 'orchestration.workerStop', {
          dispatch: worker.dispatchId
        })
      }
      return call('terminal.close', { terminal: handle })
    }
  ]
]

/** 引擎报的 Agent 名里认得出的几家；其余返回 null */
const knownAgent = (name) =>
  /^(codex|claude|kimi|opencode)$/i.exec(name ?? '')?.[1].toLowerCase() ?? null

/** 终端前台跑的是哪家 Agent（codex / claude / kimi / opencode）；普通 shell 返回 null。按 pid 缓存。 */
const agentByPid = new Map()
// 前台 Agent 进程的启动时间：同一终端里 Agent 没退出就不会变，查到一次就缓存；Agent 退了清掉
const startedByHandle = new Map()
async function agentStartedAt(handle) {
  if (!startedByHandle.has(handle)) {
    const proc = await call('terminal.inspectProcess', { terminal: handle }).catch(() => null)
    const at = iso(proc?.process?.foregroundProcessEvidence?.fence?.process?.startTime)
    if (!at) {
      return undefined
    }
    startedByHandle.set(handle, at)
  }
  return startedByHandle.get(handle)
}
function forgetStart(handle) {
  startedByHandle.delete(handle)
  return undefined
}

async function foregroundAgent(handle) {
  try {
    const proc = await call('terminal.inspectProcess', { terminal: handle })
    const pid = proc.process?.foregroundProcessEvidence?.fence?.process?.pid
    // 没有 pid 时只有前台进程名（比如 kimi）
    if (!pid) {
      return knownAgent(proc.process?.foregroundProcess)
    }
    if (!agentByPid.has(pid)) {
      agentByPid.set(pid, await agentOfPid(pid))
    }
    return agentByPid.get(pid)
  } catch {
    return null
  }
}

const badRequest = (message) =>
  Object.assign(new Error(message), { status: 400, code: 'bad_request' })

// 贴图打进去后等 Agent 把路径认成附件再回车
const IMAGE_ATTACH_MS = 500

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
  }
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw badRequest('请求体不是 JSON')
  }
}

routes.push(...businessRoutes(readJson))
routes.push(...grokBotRoutes, ...harnessRoutes)
routes.push(...workspaceChangesRoutes(), ...sessionPlanRoutes)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp'
}

// 本机端口不验令牌，所以只认本机自己的请求：
// - Host 必须是 127.0.0.1 / localhost（挡 DNS 重绑定：恶意域名解析到 127.0.0.1 再来请求）；
// - 带 Origin 的（网页发的）只认 HiveWard 自己的页面（App 窗口、开发服务器）。
//   否则随便一个网页都能在后台 POST 过来，开完全访问的 Agent、或者让本机和陌生电脑配对。
// hiwd 命令和 Agent 用的 node fetch 不带 Origin，照常放行。
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const DEV_ORIGINS = ['http://localhost:5180', 'http://127.0.0.1:5180']
function fromThisMachine(req, port) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  if (!LOCAL_HOSTS.has(host)) {
    return false
  }
  const origin = req.headers.origin
  if (!origin) {
    return true
  }
  return (
    DEV_ORIGINS.includes(origin) || [...LOCAL_HOSTS].some((h) => origin === `http://${h}:${port}`)
  )
}

/**
 * 起桥接服务。命令行直接跑时用默认参数；桌面 App 在主进程里调用，
 * 可以额外挂路由（内嵌浏览器），并顺带托管打包好的网页（staticDir，单页应用回退到 index.html）。
 */
export async function startBridge({
  port = PORT,
  lanPort = Number(hivewardEnvironment.HIVEWARD_LAN_PORT ?? 8788),
  lanTlsPort = Number(
    hivewardEnvironment.HIVEWARD_LAN_TLS_PORT ?? (lanPort === false ? 0 : lanPort + 1)
  ),
  staticDir,
  extraRoutes = [],
  terminalStreaming,
  onMachineInvite,
  onExitRegionWarning,
  captureExitEnvironment,
  regionGuard,
  projectSchedule: providedProjectSchedule,
  automationIdleCloser: providedAutomationIdleCloser,
  agentWake: providedAgentWake,
  clipboardAdapter,
  onClipboardNotice,
  computerAwake
} = {}) {
  const guard =
    regionGuard ??
    createExitRegionGuard({ capture: captureExitEnvironment, onWarning: onExitRegionWarning })
  configureExitRegionGuard(guard)
  // 电脑卡片要看的出口 IP / 所在地和电脑型号，顺着出口状态一起给组织里的电脑
  const exitIp = createExitIp(captureExitEnvironment ? { capture: captureExitEnvironment } : {})
  const machineModel = createMachineModel()
  const exitStatus = async () => ({
    ...(await guard.status()),
    warnings: guard.warnings(),
    exitIp: exitIp.current(),
    model: machineModel.current()
  })
  const lan = createLan({
    lanPort,
    onInvite: onMachineInvite,
    exitRegion: exitStatus
  })
  const workerCloser = createWorkerCloser({ call })
  // 各家额度：引擎把 /api/usage 挂在 extraRoutes 里（只有桌面 App 有），这里直接借它的处理函数
  const usageRoute = extraRoutes.find(([m, re]) => m === 'GET' && re.test('/api/usage'))
  const readUsage = async () => (usageRoute ? usageRoute[2]() : null)
  const quotaResumer = createQuotaResumer({ call, readUsage })
  const agentWake = providedAgentWake ?? createAgentWakeService()
  const projectSchedule = providedProjectSchedule ?? createProjectScheduleService()
  // 定时巡检的运行终端空闲满一小时自动关（原生只管派单下属）
  const automationIdleCloser = providedAutomationIdleCloser ?? createAutomationRunIdleCloser()
  let observing = false
  const observe = async () => {
    if (observing) {
      return
    }
    observing = true
    try {
      const listed = await call('terminal.list')
      const terminals = await Promise.all(
        listed.terminals.map(async (t) => ({
          ...t,
          agent: knownAgent(t.agentIdentity) ?? (await foregroundAgent(t.handle))
        }))
      )
      await observeDispatches(listed.terminals)
      // 启动对话由引擎的 blocked signals 处理，桥接不再替 Agent 按键。
      await Promise.allSettled([guard.observe(terminals), quotaResumer.observe(terminals)])
    } catch {
      // The runtime can be unavailable during startup.
    } finally {
      observing = false
    }
  }
  const warningTimer = setInterval(() => void observe(), 15000)
  warningTimer.unref()

  const files = createFileService()
  const clipboard = createClipboardService({
    adapter: clipboardAdapter,
    machine: lan.localMachine(),
    members: lan.onlineMembers,
    request: lan.memberRequest,
    notify: onClipboardNotice
  })
  clipboard.start()
  const mcp = createMcpService({ machine: lan.localMachine() })
  const inboxRoute = [
    'GET',
    /^\/api\/inbox\/wait$/,
    async (req, _params, url, context) => {
      const caller = reviewCaller(req)
      if (context?.isLan || caller.kind !== 'agent' || !caller.id) {
        throw Object.assign(new Error('只能由本机 HiveWard 终端或会话收取自己的消息'), {
          status: 403,
          code: 'forbidden'
        })
      }
      const raw = url.searchParams.get('timeout')
      const seconds = raw === null ? 60 : Number(raw)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw badRequest('timeout 必须是大于 0 的秒数')
      }
      const party = await resolveDispatcher(caller, caller.cwd, context?.localMachineId)
      const receipt = await agentWake.waitForInbox(party, Math.min(60, seconds) * 1000, req)
      return { ...receipt, text: formatWakeMessages(receipt.messages) }
    }
  ]
  // 老板在网页上点 × 关下属：过 5 秒才真关，这段时间里能撤销
  const workerCloseRoutes = [
    [
      'POST',
      /^\/api\/workers\/([^/]+)\/close$/,
      async (_req, [handle]) => {
        await snapshot()
        return workerCloser.requestClose(handle)
      }
    ],
    [
      'POST',
      /^\/api\/workers\/([^/]+)\/close\/undo$/,
      async (_req, [handle]) => ({ undone: workerCloser.undo(handle) })
    ]
  ]
  // 额度用完的提示（顶栏、hiwd）和「额度恢复后自动继续」开关
  const quotaRoutes = [
    [
      'GET',
      /^\/api\/quota$/,
      async () => {
        const listed = await call('terminal.list', {}).catch(() => ({ terminals: [] }))
        const live = new Set(listed.terminals.map((t) => t.handle))
        const usage = await readUsage().catch(() => null)
        return {
          providers: quotaAlerts(usage, quotaStopped(dispatches(), live)),
          ...quotaSettings()
        }
      }
    ],
    [
      'POST',
      /^\/api\/quota\/settings$/,
      async (req, _params, _url, context) => {
        if (context?.isLan) {
          throw Object.assign(new Error('只能在这台电脑上改'), { status: 403, code: 'forbidden' })
        }
        return saveQuotaSettings(await readJson(req))
      }
    ]
  ]
  const all = [
    ...routes,
    ...workerCloseRoutes,
    ...quotaRoutes,
    inboxRoute,
    ...extraRoutes,
    ...sessionAwakeRoutes(computerAwake, readJson)
  ]
  const handle = async (req, res, isLan = false) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    try {
      const url = new URL(req.url, 'http://x')
      files.checkForward(req, url)
      clipboard.checkForward(req, url)
      mcp.checkForward(req, url)
      checkGrokBotForward(req, url)
      if (!isLan && !fromThisMachine(req, port)) {
        throw Object.assign(new Error('只接受本机 HiveWard 页面和 hiwd 命令的请求'), {
          status: 403,
          code: 'forbidden'
        })
      }
      if (
        isLan ? await lan.lanRequest(req, res, url) : await lan.localRequest(req, res, url, handle)
      ) {
        return
      }
      const peer = isLan && req.socket.encrypted ? lan.authenticate(req) : null
      if (await files.handle(req, res, url, { remote: isLan, peer })) {
        return
      }
      if (await clipboard.handle(req, res, url, { remote: isLan, peer })) {
        return
      }
      if (await mcp.handle(req, res, url, { remote: isLan, peer })) {
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/exit-region') {
        return reply(200, await exitStatus())
      }
      if (!isLan && url.pathname === '/api/exit-region/policy') {
        if (req.method === 'GET') {
          return reply(200, { allowedCountries: guard.policy() })
        }
        if (req.method === 'POST') {
          return reply(200, {
            allowedCountries: guard.setPolicy((await readJson(req)).allowedCountries)
          })
        }
      }
      if (!isLan && req.method === 'POST' && url.pathname === '/api/exit-region/refresh') {
        guard.invalidate()
        await exitIp.refresh()
        return reply(200, {
          ...(await guard.status({ fresh: true })),
          warnings: guard.warnings(),
          exitIp: exitIp.current(),
          model: machineModel.current()
        })
      }
      if (!isLan && staticDir && req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return await serveStatic(staticDir, url.pathname, res)
      }
      const route = all.find(([m, re]) => m === req.method && re.test(url.pathname))
      if (!route) {
        return reply(404, { error: { code: 'not_found', message: req.url } })
      }
      const params = route[1].exec(url.pathname).slice(1).map(decodeURIComponent)
      const body = await route[2](req, params, url, {
        isLan,
        peerMachineId: peer?.id,
        peerMachineName: peer?.name,
        localMachineId: lan.localMachine().id,
        onlineMembers: lan.onlineMembers,
        members: lan.members,
        memberRequest: lan.memberRequest
      })
      if (body?.raw instanceof Buffer) {
        res.writeHead(200, {
          'content-type': body.type,
          'cache-control': body.cacheControl ?? 'no-store',
          ...body.headers
        })
        return res.end(body.raw)
      }
      reply(200, body)
    } catch (e) {
      const status = e.status ?? (e instanceof HiveWardUnavailable ? 503 : 502)
      const code =
        e.code ?? (e instanceof HiveWardUnavailable ? 'hiveward_unavailable' : 'hiveward_error')
      if (!res.headersSent) {
        reply(status, {
          error: {
            code,
            message: e.message,
            ...(code === 'file_changed' ? { mtime: e.mtime } : {}),
            ...(code === 'exit_region_blocked' ? { details: e.details } : {}),
            ...(e.sessionId ? { sessionId: e.sessionId } : {})
          }
        })
      } else {
        res.destroy()
      }
    }
  }
  const server = createServer((req, res) => handle(req, res))
  const lanServer = lanPort === false ? null : createServer((req, res) => handle(req, res, true))
  const tlsServer =
    lanPort === false
      ? null
      : createHttpsServer(lan.tlsOptions, (req, res) => handle(req, res, true))
  lanServer?.on('upgrade', (_req, socket) =>
    socket.end('HTTP/1.1 403 TLS Required\r\nConnection: close\r\n\r\n')
  )
  const mcpSockets = createMcpWebSocketHandler({
    server,
    lan,
    fromThisMachine,
    service: mcp
  })
  const closeStreams = installTerminalWebSockets({
    server,
    lanServer: tlsServer,
    lan,
    fromThisMachine,
    streaming: terminalStreaming,
    mcp: mcpSockets
  })
  const listen = (s, port, host) =>
    new Promise((resolve, reject) => {
      s.once('error', reject)
      s.listen(port, host, () => {
        s.removeListener('error', reject)
        resolve()
      })
    })
  const closeLocal = server.close.bind(server)
  server.close = (callback) => {
    files.close()
    const clipboardClosed = clipboard.close()
    const mcpClosed = mcp.close()
    clearInterval(warningTimer)
    workerCloser.close()
    projectSchedule.close()
    automationIdleCloser.close()
    agentWake.close()
    mcpSockets.close()
    closeStreams()
    const discoveryClosed = lan.close()
    const lanClosed = new Promise((resolve) => {
      if (lanServer) {
        lanServer.close(resolve)
      } else {
        resolve()
      }
    })
    lanServer?.closeAllConnections()
    const tlsClosed = new Promise((resolve) => {
      if (tlsServer) {
        tlsServer.close(resolve)
      } else {
        resolve()
      }
    })
    tlsServer?.closeAllConnections()
    return closeLocal((error) => {
      void Promise.all([discoveryClosed, lanClosed, tlsClosed, clipboardClosed, mcpClosed]).then(
        () => callback?.(error)
      )
    })
  }
  try {
    if (tlsServer) {
      await listen(tlsServer, lanTlsPort, '0.0.0.0')
      lan.setTlsPort(tlsServer.address().port)
    }
    await listen(server, port, '127.0.0.1')
    if (lanServer) {
      await listen(lanServer, lanPort, '0.0.0.0')
    }
    agentWake.start()
    await projectSchedule.start()
    automationIdleCloser.start()
    console.log(
      `HiveWard bridge on http://127.0.0.1:${server.address().port}${lanServer ? `; LAN :${lanPort}` : ''}`
    )
    return server
  } catch (e) {
    server.close()
    throw e
  }
}

async function serveStatic(dir, pathname, res) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(dir, safe)
  if (!file.startsWith(dir)) {
    file = join(dir, 'index.html')
  }
  const data = await readFile(file).catch(() => readFile(join(dir, 'index.html')))
  res.writeHead(200, {
    'content-type':
      MIME[extname(file)] ?? (extname(file) ? 'application/octet-stream' : MIME['.html'])
  })
  res.end(data)
}

// 命令行直接运行：node server/hiveward-bridge.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startBridge()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(() => process.exit(0))
      server.closeAllConnections()
    })
  }
}
