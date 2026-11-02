/**
 * OPC 前后端接口契约（v0.1 草案，由前端起草，后端确认后为准）。
 *
 * 约定：
 * - 所有接口前缀 /api，JSON，时间一律 ISO 8601 字符串（UTC）。
 * - 错误统一返回 ApiError，HTTP 状态码 4xx/5xx。
 * - 状态以 Orca 为真相源；后端只做聚合、映射和审计（见 docs/OPC-DESIGN.md）。
 * - 标 TODO(P0) 的字段/枚举要等 P0 spike 拿到真实 Orca JSON 后再定。
 * - 每个字段后面的「← 来源」注明它从哪条 Orca 命令/消息来；没有来源的字段只能来自 OPC 自己的库。
 *   前端不展示任何没有真实来源的数据。
 */

// ───────────── 基础类型 ─────────────

export type Id = string
export type IsoTime = string

/** Orca 的存活三态，原样透传；unverifiable 不等于死亡。 */
export type Liveness = 'live' | 'unverifiable' | 'exited'

/** Orca 能启动的 agent。TODO(P0)：确认 kimi 是否为 Orca 已知 id。 */
export type AgentKind = 'claude' | 'codex' | 'kimi' | 'opencode' | 'grok' | (string & {})

export interface ApiError {
  error: {
    code: string
    message: string
    /** Orca 原始错误码（如有），例如 terminal_handle_stale */
    orcaCode?: string
  }
}

// ───────────── 执行层健康 ─────────────

export interface OrcaHealth {
  reachable: boolean
  appVersion?: string
  runtimeState?: string
  /** 采集器最后一次成功采集时间；超时未更新时前端显示“同步中断” */
  collectedAt: IsoTime
  /** 方案 A 的老板信箱是否在线 */
  hq?: { runId: Id; liveness: Liveness }
}

// ───────────── 业务与负责人 ─────────────

export type BusinessStatus = 'active' | 'paused' | 'archived'

export interface LeaderSeat {
  id: Id
  agent: AgentKind
  model?: string
  /** ← worktree ps: agents[] 的存活状态；终端不存在时为 exited */
  liveness: Liveness
  /** ← OPC 库：LeaderSeat.state */
  state: 'launching' | 'live' | 'stale' | 'replaced'
  /** 负责人写的一句话进度 ← worktree ps: worktrees[].comment（负责人用 orca worktree set --comment 写） */
  comment?: string
  /** ← Orca 进程 startTime / worker-show createdAt，或 OPC 负责人启动记录；无来源为空字符串。 */
  startedAt: IsoTime
}

export interface BusinessCounts {
  objectivesRunning: number
  tasksOpen: number
  tasksDone: number
  workersLive: number
  decisionsPending: number
}

export interface BusinessSummary {
  id: Id
  name: string
  /** 名字来源：auto 从项目里认出来（productName / README 标题 / 目录名…），user 老板改过 */
  nameSource?: 'auto' | 'user'
  /** 项目自己的 logo（/api/projects/:id/logo?v=…）；认不出时为空，网页画素色占位图标 */
  logo?: string
  /** 旧数据里的 emoji 图标，已不再显示 */
  icon?: string
  status: BusinessStatus
  priority: 1 | 2 | 3
  workspacePath: string
  /** 引擎项目 id（repo.list）；目录还没登记成项目 / 已移除时为空 */
  repoId?: Id
  /** 引擎项目类型：git 仓库或普通文件夹 */
  kind?: 'git' | 'folder'
  /** 业务目录已不存在（记录保留，不删） */
  missing?: boolean
  leader: LeaderSeat | null
  counts: BusinessCounts
  lastEvent?: TimelineEvent
  updatedAt: IsoTime
}

// ───────────── 目标 / 任务 / 下属 ─────────────

export type ObjectiveStatus = 'draft' | 'sent' | 'running' | 'done' | 'failed'

/** Run 无 status：任务全 completed → done，有 failed → failed，其余（含空 Run）→ running。 */
export interface Objective {
  id: Id
  businessId: Id
  /** 对应 Orca Run；负责人建好 Run 前为空 */
  runId?: Id
  title: string
  status: ObjectiveStatus
  progress: { done: number; total: number }
  createdAt: IsoTime
  closedAt?: IsoTime
}

/** P0 实测及源码核对：Orca 六种 status 与此枚举同名透传；未知值报 orca_invalid_data，不猜测映射。 */
export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'blocked' | 'completed' | 'failed'

/** 下属完成任务时的汇报，对应 Orca worker_done 消息的字段。 */
export interface TaskReport {
  outcome: 'succeeded' | 'failed'
  /** 三句话的执行摘要 ← worker_done 消息的 body */
  summary: string
  reportedAt: IsoTime
  /** ← worker_done 的 --files-modified */
  filesModified?: string[]
  /** ← worker_done 的 --report-path */
  reportPath?: string
}

export interface Task {
  id: Id
  businessId: Id
  objectiveId: Id
  runId: Id
  /** spec 的短标题（后端截断） */
  title: string
  status: TaskStatus
  deps: Id[]
  assignee?: { agent: AgentKind; dispatchId: Id; liveness: Liveness }
  /** 阻塞原因（status 为 blocked 时） */
  blockedReason?: string
  report?: TaskReport
  /** ← task-list updated_at/completed_at，或 worker_done.created_at，最后回退任务 created_at（Orca 不提供其他更新时间）。 */
  updatedAt: IsoTime
  /** 派单任务（opc new / tell）才有：谁派的 ← OPC 派单记录 data/dispatches.json */
  /** owner = 老板在架构图的老板卡上直接派给总 Agent 的 */
  dispatchedBy?: {
    kind: 'claude-desktop' | 'claude-code' | 'grok' | 'cli' | 'owner'
    id: Id
    label: string
  }
  /** 派单任务所在项目名（不属于任何业务时用来标注） ← 派单记录 project */
  project?: string
  /** 派单任务的终端还在时：它的 handle，点开能看实时输出 */
  terminal?: string
  /** 派单任务没汇报完时又补充的话（opc tell），按先后 */
  followUps?: string[]
}

export interface Worker {
  dispatchId: Id
  /** 无 dispatch 的终端下属用空字符串表示未绑定任务；拓扑省略 taskId。 */
  taskId: Id
  agent: AgentKind
  model?: string
  liveness: Liveness
  /** ← worker-list terminalState/resource.terminalState；缺失时 worker-show 有终端 → active，无证据 → release_unknown。 */
  terminalState:
    | 'active'
    | 'reclaimable'
    | 'retained'
    | 'release_pending'
    | 'release_unknown'
    | 'released'
  /** ← 最近一条 heartbeat 消息的 --phase */
  phase?: string
  /** ← 最近一条 heartbeat 消息的时间 */
  lastHeartbeatAt?: IsoTime
  /** ← worker-show 经身份核验的 terminal.handle，或 terminal.list handle。 */
  terminal?: string
  /** 没绑任务的终端下属：终端标题 ← terminal.list: title */
  title?: string
  /** ← Orca 进程 startTime / worker-show createdAt，或 OPC 负责人启动记录；无来源为空字符串。 */
  startedAt: IsoTime
}

// ───────────── 待我决定 ─────────────

export type DecisionSource = 'gate' | 'escalation' | 'question'
export type Urgency = 'high' | 'normal' | 'low'

export interface Decision {
  id: Id
  businessId: Id
  objectiveId?: Id
  source: DecisionSource
  question: string
  body?: string
  options: string[]
  /** 负责人给出的建议选项 ← 消息 payload.recommendation（Leader 简报要求填写） */
  recommendation?: string
  /** ← 消息 --priority；gate 默认 normal */
  urgency: Urgency
  state: 'pending' | 'resolved' | 'expired'
  /** ← orchestration.send 回执；gate 仅已转交时仍为 pending，待 Coordinator 真正 resolve。 */
  delivery?: 'enqueued'
  /** 派单 Agent 停下来问的（它的回话里带【需要确认】）← 派单记录；答复会直接发回这个终端 */
  dispatch?: { handle: string; agent: AgentKind | null; by: string }
  /** Agent 附的截图地址（/api/shots/…） ← 它回话里的 /tmp/opc-shot-*.png */
  screenshot?: string
  createdAt: IsoTime
  resolution?: { choice: string; note?: string; custom?: boolean; resolvedAt: IsoTime }
}

// ───────────── 时间线 ─────────────

export type TimelineKind =
  | 'leader'
  | 'objective'
  | 'task'
  | 'worker'
  | 'decision'
  | 'instruction'
  | 'system'

/** GET /api/timeline?businessId=&cursor=&limit= → Page<TimelineEvent>，按时间倒序 */
export interface TimelineEvent {
  id: Id
  ts: IsoTime
  businessId?: Id
  kind: TimelineKind
  title: string
  detail?: string
  /** 哪家 Agent（claude / codex / kimi…），网页画它的 logo */
  agent?: AgentKind
  /** 相关终端：网页点这条跳到项目页的这个终端 */
  terminal?: string
  taskId?: Id
  decisionId?: Id
  /** 项目目录（还没登记成项目的终端也能看出在哪） */
  path?: string
}

// ───────────── 指令 ─────────────

export interface Instruction {
  id: Id
  businessId: Id
  objectiveId?: Id
  kind: 'objective' | 'followup' | 'decision' | 'nudge'
  body: string
  delivery: 'pending' | 'enqueued' | 'failed'
  createdAt: IsoTime
}

// ───────────── 组织示意图 ─────────────

/**
 * 架构图像并联电路：每块业务一行的根是项目节点（kind: project，项目 = 引擎里的项目），
 * 项目 → 这块业务的总 Agent（leader）有两条并联的路——一条直连，一条经过这块业务自己的
 * Grok Bot（kind: grok，leader.via 指向它）；总 Agent 后面挂它的下属（worker）。
 * 不属于任何业务的派单目录也是一行（unregistered: true），只有直连，没有 Grok。
 */
export interface TopologyNode {
  id: Id
  kind: 'project' | 'owner' | 'grok' | 'leader' | 'worker'
  /** owner 是旧版老板节点的兼容占位：3a 后台起 topology 不再返回它，后续由前端清理后移除 */
  /** 不是登记过的项目，只是有人在这个目录里派过活 */
  unregistered?: boolean
  /** 树结构：project 无 parent（一行的根）；leader 的 parent 是 project；worker 的 parent 是 leader；grok 不在树里，由 leader.via 引用 */
  parentId?: Id
  label: string
  sublabel?: string
  agent?: AgentKind
  liveness?: Liveness
  businessId?: Id
  /** 正在做什么（当前任务标题或阶段）；空闲时为空 */
  activity?: string
  /** 当前任务的 id ← worker-list: workers[].taskId */
  taskId?: Id
  /** 下属的派发 id ← worker-list: workers[].dispatchId；用于读它的终端画面 */
  dispatchId?: Id
  /** 对应的 Orca 终端 ← terminal.list: handle；有它就能在详情里看这个 Agent 的对话、直接说话 */
  terminal?: string
  /** 总 Agent 是某个派单会话（比如在项目目录里开着的 Claude Code）时：它的派单方 id ← 派单记录 by.id，点开看它派出去的活 */
  dispatcher?: Id
  /** leader：和直连并联的那个 Grok Bot 节点的 id */
  via?: Id
  /** leader：这一行对应的目录（业务的 workspacePath 或项目路径），没经派单的 Agent 按它归行 */
  project?: string
  /** 最近一次心跳 / 活动时间 */
  lastSeenAt?: IsoTime
  /** 节点底部的一行指标，例如 ["任务 9/14", "待决定 1"] */
  stats?: string[]
  /** 需要老板注意（有待决定或负责人失联） */
  attention?: boolean
  /** 手上的活走到哪了：等接单 / 干活中 / 已完成（待验收）/ 等确认 / 失败 / 空闲 / 已退出 */
  state?: NodeState
}

export type NodeState = 'pending' | 'working' | 'done' | 'blocked' | 'failed' | 'idle' | 'exited'

export interface TopologyResponse {
  nodes: TopologyNode[]
}

// ───────────── 聚合响应 ─────────────

export interface OverviewResponse {
  health: OrcaHealth
  businesses: BusinessSummary[]
  decisionsPending: number
  recentEvents: TimelineEvent[]
}

export interface BusinessDetailResponse {
  business: BusinessSummary
  /** 负责人授权边界（登记业务时填写） */
  authority: string
  objectives: Objective[]
  tasks: Task[]
  workers: Worker[]
  decisions: Decision[]
  recentEvents: TimelineEvent[]
}

/** 终端当前画面 ← terminal read --screen（负责人）/ orchestration worker-read（下属） */
export interface LeaderScreenResponse {
  text: string
  capturedAt: IsoTime
  /** Agent 自己的对话记录（找得到时），有就默认按对话显示 */
  items?: ChatItem[]
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

// ───────────── 现场：直连 Orca 终端（server/orca-bridge.mjs） ─────────────

/** ← terminal.list */
export interface OrcaTerminal {
  handle: string
  /** 前台在跑的 Agent ← terminal.inspectProcess + 进程命令行；普通 shell 为 null */
  agent: 'codex' | 'claude' | 'kimi' | null
  /** 跑着 Agent 时它的状态 ← terminal.agentStatus：working / idle / permission 等 */
  status?: string
  title?: string | null
  /** 终端所在项目路径 */
  project: string
  branch?: string
  connected: boolean
  writable: boolean
  lastOutputAt?: number
  /** 屏幕最后一行 */
  preview: string
}

/** ← terminal.read --screen + terminal.agentStatus */
export interface OrcaScreen {
  text: string
  capturedAt: IsoTime
  /** 终端进程还在 */
  running: boolean
  /** 终端里跑着 Agent 时：working / idle 等；不是 Agent 时为 null */
  agent: string | null
}

/** 对话视图里的一条：来自 Agent 自己的对话记录（codex rollout / claude projects / kimi wire） */
export type ChatItem =
  | { id: string; kind: 'user' | 'assistant' | 'thinking'; text: string; ts?: IsoTime }
  | {
      id: string
      kind: 'tool'
      tool: 'command' | 'read' | 'edit' | 'other'
      title: string
      output?: string
      status: 'running' | 'ok' | 'error'
      ts?: IsoTime
    }

export interface OrcaChat {
  /** 终端前台的 Agent；不是 Agent 时为 null */
  agent: 'codex' | 'claude' | 'kimi' | null
  /** 对话记录文件；找不到时为 null，网页回退到终端视图 */
  source: string | null
  items: ChatItem[]
}

/** ← repo.list */
export interface OrcaProject {
  path: string
  name: string
}

export interface OrcaCreateTerminalRequest {
  project: string
  /** 新开的 Agent 一律完全访问模式启动 */
  agent?: 'claude' | 'codex' | 'kimi'
  title?: string
  /** leader：开出来当这一行的总 Agent，Claude Code 会带上总 Agent 的岗位说明 */
  role?: 'leader'
}

/**
 * 真终端的 WebSocket：GET /api/orca/terminals/:handle/stream?cols=&rows= 升级而来，全是 JSON 文本帧。
 * 连上 / 重连后第一帧是 snapshot（网页 reset 后整段写入，还原屏幕和一段滚动历史），之后是 data。
 */
export type TerminalStreamServerFrame =
  | { type: 'snapshot'; data: string; cols: number; rows: number }
  | { type: 'data'; data: string }
  | { type: 'exit'; code?: number }
  | { type: 'error'; message: string }

/** 网页发给终端的：键盘输入原样写进 PTY；网页的终端大小变了 */
export type TerminalStreamClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }

export interface OrcaSendRequest {
  text?: string
  enter?: boolean
  agentPrompt?: boolean
  interrupt?: boolean
}

// ───────────── 请求体 ─────────────

export interface CreateBusinessRequest {
  name: string
  icon?: string
  workspacePath: string
  priority: 1 | 2 | 3
  leaderAgent: AgentKind
  leaderModel?: string
  /** 负责人授权边界，渲染进简报 */
  authority: string
}

/** 登记项目（= 业务）：目录必须存在，git / folder 自动判断 */
export type CreateProjectRequest = {
  path: string
  name?: string
}

/** 改项目 / 业务：项目名同步引擎 displayName */
export type UpdateProjectRequest = {
  name?: string
  icon?: string
  status?: BusinessStatus
  leaderAgent?: AgentKind
  leaderModel?: string
}

export interface CreateObjectiveRequest {
  title: string
  brief: string
}

export interface SendInstructionRequest {
  body: string
  objectiveId?: Id
  /** 投递后再用 terminal send 唤醒负责人 */
  nudge?: boolean
}

export interface ResolveDecisionRequest {
  /** 选中的选项原文；custom=true 时是老板自己写的回复 */
  choice: string
  /** 随选项附带的话 */
  note?: string
  /** 不在 options 里、老板自定义的回复 */
  custom?: boolean
}

// ───────────── 实时推送（SSE: GET /api/events） ─────────────

/** 后端只推"哪里变了"，前端据此让对应查询失效重取。 */
export type ServerEvent =
  | { type: 'overview' }
  | { type: 'business'; businessId: Id }
  | { type: 'decisions' }
  | { type: 'timeline'; event: TimelineEvent }
  | { type: 'health'; health: OrcaHealth }

// ───────────── Agent 出口地区准入（各机器本机测量并执行） ─────────────

export type AgentExitPolicy = { claude: string[]; codex: string[]; kimi: string[] | null }
export type AgentExitWarning = {
  id: Id
  terminal: string
  agent: string
  country: string | null
  detectedAt: IsoTime
  /** 仅提醒，不自动终止已有 Agent；网页按 id 去重显示 */
  message: string
}
export type AgentExitRegion = {
  /** ISO 两位国家码；未知为 null，不提供 IP */
  country: string | null
  checkedAt: IsoTime
  method: 'login-shell-proxy-trace' | 'login-shell-route-trace' | 'unavailable'
  /** 固定中立检测 URL，不访问服务商；不跟随重定向 */
  source: string | null
  reason: string | null
  /** 网页必须展示：分流规则可能不同，建议开 TUN 或全局模式 */
  limitation: string
  agents: Record<string, { allowed: boolean; allowedCountries: string[] | null }>
  warnings?: AgentExitWarning[]
}
/** GET /api/exit-region：本机状态 + warnings；已配对机器可读。
 * POST /api/exit-region/refresh {}：强制重测，仅本机。
 * GET /api/exit-region/policy → {allowedCountries: AgentExitPolicy}，仅本机。
 * POST /api/exit-region/policy {allowedCountries: AgentExitPolicy}：整份替换，原子保存。
 * 默认 claude/codex 仅 US，kimi=null 不限；空数组禁止该 Agent，不允许删除受限 Agent 策略。
 * 展示缓存 180 秒；每次启动最多使用 60 秒内结果，网卡/代理环境变化使缓存失效。
 */
export type AgentExitBlockedError = {
  error: {
    code: 'exit_region_blocked'
    message: string
    details: {
      agent?: string
      country?: string | null
      allowedCountries?: string[]
      checkedAt?: IsoTime
      method?: string
      reason: string
    }
  }
}

// ───────────── 多台电脑（局域网互联，server/lan.mjs） ─────────────
//
// 每台电脑都跑 OPC，彼此平等：任意一台都能看、能控制已配对的其他电脑。
// 本机 /api/m/:machineId/<路径> 原样转发到那台电脑的 /api/<路径>（走它的局域网端口 + 配对令牌）。

/** 局域网里的一台 OPC */
export interface Machine {
  /** 机器 id：首次启动生成，存 data/machine.json，不随 IP 变 */
  id: Id
  /** 电脑名（scutil --get ComputerName），用户可在配对后改 */
  name: string
  /** 是不是正在看的这台 */
  self: boolean
  /** 已获本机同意并保存成员令牌；仅发现不会授予远程控制权限 */
  paired: boolean
  /** 本机或已配对电脑的出口状态；未检测/未配对/远端不支持时 null */
  exitRegion: AgentExitRegion | null
  /** 最近通过 Bonjour / UDP 发现；与成员身份独立 */
  discovered: boolean
  invite: 'sent' | 'incoming' | null
  /** online：最近一次握手成功；offline：配对过但现在连不上；本机永远 online */
  status: 'online' | 'offline'
  /** 局域网地址 host:port（Bonjour 解析或手动填写）；本机为空 */
  address?: string
  lastSeenAt?: IsoTime
  /** 对方的 OPC 版本 */
  version?: string
  /** 在线时顺带取的概况，离线或没配对时为空 */
  summary?: {
    orcaReachable: boolean
    /** 正在跑的 Agent 终端数 */
    agents: number
    tasksOpen: number
    decisionsPending: number
  }
}

export type MachineOrganization = {
  id: Id
  name: string
  members: Id[]
}

export type MachineInvitation = {
  id: Id
  direction: 'sent' | 'incoming'
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled'
  /** user / name 是对方声明的身份，address 是接收端观察到的地址；UI 必须展示远控授权警告 */
  machine: { id: Id; name: string; address: string; user?: string }
  organization: { id: Id; name: string }
  expiresAt: IsoTime
}

/** 移出/退出的持久通知，保留最近 50 条；网页按 id 去重展示。 */
export type MachineOrganizationNotice = {
  id: Id
  type: 'removed' | 'member-left' | 'member-removed'
  actor: { id: Id; name: string }
  machineId: Id
  organization: { id: Id; name: string }
  createdAt: IsoTime
}

/** GET /api/machines：网页每 2 秒轮询，包括前台全局邀请确认弹层；不依赖 SSE。
 * incoming + pending 时展示谁、电脑名、地址、组织名和同意/拒绝。
 * 邀请默认 120 秒有效；结果保留 10 分钟，服务重启后未完成邀请失效。
 */
export interface MachinesResponse {
  machines: Machine[]
  organization: MachineOrganization | null
  invitations: MachineInvitation[]
  /** 离线成员未收到撤销的数量；大于 0 时不得宣称全组织已解除控制 */
  pendingRemovals: number
  /** 离线成员待接收的新成员凭据数量，恢复在线后自动重试 */
  pendingMembers: number
  /** 组织改名尚未同步到的成员数量 */
  pendingOrganizationUpdates: number
  organizationNotices: MachineOrganizationNotice[]
}

/** POST /api/machines/invite → MachineInvitation。machineId（发现列表）或 address（手动 host:port）。 */
export type MachineInviteRequest = {
  machineId?: Id
  address?: string
}

/** POST /api/machines/invitations/:id/accept | reject | cancel，空 body → MachineInvitation。
 * accept/reject 只能在被邀请电脑本机执行，cancel 只能在邀请方执行。
 * POST /api/machines/:id/remove 与 /api/machines/organization/leave → 此结果。
 * 任意成员可移出；撤销通知持久化重试，pending=0 才表示全部在线端已确认。
 */
export type MachineRemovalResponse = {
  ok: true
  pending: number
}

// POST /api/machines/organization/rename，{name} → MachineOrganization。
// POST /api/machines/:id/rename，{name} → {ok:true}（本地显示名）。
// 配对码及旧 pair/unpair 路由已删除；旧 peers.json 凭据原样保留并迁移组织。

// ───────────── 路由表 ─────────────

export const endpoints = {
  overview: { method: 'GET', path: '/api/overview' },
  businessDetail: { method: 'GET', path: '/api/businesses/:id' },
  leaderScreen: { method: 'GET', path: '/api/businesses/:id/leader/screen' },
  workerScreen: { method: 'GET', path: '/api/workers/:dispatchId/screen' },
  orcaTerminals: { method: 'GET', path: '/api/orca/terminals' },
  orcaProjects: { method: 'GET', path: '/api/orca/projects' },
  orcaScreen: { method: 'GET', path: '/api/orca/terminals/:handle/screen' },
  orcaChat: { method: 'GET', path: '/api/orca/terminals/:handle/chat' },
  orcaSend: { method: 'POST', path: '/api/orca/terminals/:handle/send' },
  orcaCreate: { method: 'POST', path: '/api/orca/terminals' },
  orcaClose: { method: 'POST', path: '/api/orca/terminals/:handle/close' },
  createBusiness: { method: 'POST', path: '/api/businesses' }, // 旧接口，同 POST /api/projects
  createProject: { method: 'POST', path: '/api/projects' }, // CreateProjectRequest → { business }
  updateProject: { method: 'PATCH', path: '/api/projects/:id' }, // UpdateProjectRequest → { business }
  projectLogo: { method: 'GET', path: '/api/projects/:id/logo' }, // ?v=<logo 文件 mtime>，二进制图片
  deleteProject: { method: 'DELETE', path: '/api/projects/:id' }, // 从引擎移除项目（不删磁盘文件），记录标 removedAt
  launchLeader: { method: 'POST', path: '/api/businesses/:id/leader' },
  createObjective: { method: 'POST', path: '/api/businesses/:id/objectives' },
  sendInstruction: { method: 'POST', path: '/api/businesses/:id/instructions' },
  decisions: { method: 'GET', path: '/api/decisions' }, // ?state=pending
  resolveDecision: { method: 'POST', path: '/api/decisions/:id/resolve' },
  timeline: { method: 'GET', path: '/api/timeline' }, // ?businessId=&cursor=&limit= → Page<TimelineEvent>
  tasks: { method: 'GET', path: '/api/tasks' }, // ?businessId=&status=（不传为全部业务，含已完成任务的汇报）
  topology: { method: 'GET', path: '/api/topology' }, // ?businessId=（不传为公司级：老板 → 全部负责人 → 全部在岗下属）
  events: { method: 'GET', path: '/api/events' }, // SSE
  machines: { method: 'GET', path: '/api/machines' },
  exitRegion: { method: 'GET', path: '/api/exit-region' },
  refreshExitRegion: { method: 'POST', path: '/api/exit-region/refresh' },
  exitRegionPolicy: { method: 'GET', path: '/api/exit-region/policy' },
  setExitRegionPolicy: { method: 'POST', path: '/api/exit-region/policy' },
  inviteMachine: { method: 'POST', path: '/api/machines/invite' },
  acceptMachineInvite: { method: 'POST', path: '/api/machines/invitations/:id/accept' },
  rejectMachineInvite: { method: 'POST', path: '/api/machines/invitations/:id/reject' },
  cancelMachineInvite: { method: 'POST', path: '/api/machines/invitations/:id/cancel' },
  leaveOrganization: { method: 'POST', path: '/api/machines/organization/leave' },
  renameOrganization: { method: 'POST', path: '/api/machines/organization/rename' },
  renameMachine: { method: 'POST', path: '/api/machines/:id/rename' }, // { name }
  removeMachine: { method: 'POST', path: '/api/machines/:id/remove' },
  onMachine: { method: 'ANY', path: '/api/m/:machineId/*' } // 转发到那台电脑的 /api/*
} as const
