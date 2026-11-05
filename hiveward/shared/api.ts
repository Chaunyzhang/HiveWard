import type {
  HivewardSeatRuntime,
  HivewardCrewSnapshot,
  ProjectPreset,
  ProjectSchedule,
  HivewardWorkerReadMetadata
} from './hiveward-orchestration-api'
export type {
  ProjectPreset,
  HivewardSeatRuntime,
  HivewardWorkerStartRequest,
  HivewardWorkerTellRequest,
  ProjectSchedule,
  SetProjectScheduleRequest,
  HivewardWorkerReadMetadata
} from './hiveward-orchestration-api'
/**
 * HiveWard 前后端接口契约（v0.1 草案，由前端起草，后端确认后为准）。
 *
 * 约定：
 * - 所有接口前缀 /api，JSON，时间一律 ISO 8601 字符串（UTC）。
 * - 错误统一返回 ApiError，HTTP 状态码 4xx/5xx。
 * - 状态以 HiveWard 为真相源；后端只做聚合、映射和审计（见 docs/HiveWard-DESIGN.md）。
 * - 标 TODO(P0) 的字段/枚举要等 P0 spike 拿到真实 HiveWard JSON 后再定。
 * - 每个字段后面的「← 来源」注明它从哪条 HiveWard 命令/消息来；没有来源的字段只能来自 HiveWard 自己的库。
 *   前端不展示任何没有真实来源的数据。
 */

// ───────────── 基础类型 ─────────────

export type Id = string
export type IsoTime = string

/** HiveWard 的存活三态，原样透传；unverifiable 不等于死亡。 */
export type Liveness = 'live' | 'unverifiable' | 'exited'

/** HiveWard 能启动的 agent。TODO(P0)：确认 kimi 是否为 HiveWard 已知 id。 */
export type AgentKind = 'claude' | 'codex' | 'kimi' | 'opencode' | 'grok' | (string & {})

export type ApiError = {
  error: {
    code: string
    message: string
    /** HiveWard 原始错误码（如有），例如 terminal_handle_stale */
    hivewardCode?: string
  }
}

// ───────────── 执行层健康 ─────────────

export type HiveWardHealth = {
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

export type LeaderSeat = {
  id: Id
  agent: AgentKind
  model?: string
  /** ← worktree ps: agents[] 的存活状态；终端不存在时为 exited */
  liveness: Liveness
  /** ← HiveWard 库：LeaderSeat.state */
  state: 'launching' | 'live' | 'stale' | 'replaced'
  /** 负责人写的一句话进度 ← worktree ps: worktrees[].comment（负责人用 hiveward worktree set --comment 写） */
  comment?: string
  /** ← HiveWard 进程 startTime / worker-show createdAt，或 HiveWard 负责人启动记录；无来源为空字符串。 */
  startedAt: IsoTime
}

export type BusinessCounts = {
  objectivesRunning: number
  tasksOpen: number
  tasksDone: number
  workersLive: number
  decisionsPending: number
}

export type BusinessSummary = {
  crew?: Record<string, HivewardCrewSnapshot>
  id: Id
  name: string
  /** 名字来源：auto 从项目里认出来（productName / README 标题 / 目录名…），user 老板改过 */
  nameSource?: 'auto' | 'user'
  /** 项目自己的 logo（/api/businesses/:id/logo?v=…）；认不出时为空，网页画素色占位图标 */
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
  /** Personal Agent 位坐的是哪家（PersonalAgentId）；空着时 null（旧版电脑不返回） */
  personalAgent?: string | null
  /** 那家产品里具体哪个 Agent（Grok Bot 里某个 Bot 的 id）；还没选时 null */
  personalAgentBot?: string | null
  /** 旧版「一块业务一个负责人」：网页已不用，只为局域网里的旧版本电脑保留，之后删 */
  leader: LeaderSeat | null
  /** CEO 座位：座位常驻、人不常驻；空着时 null（旧版电脑不返回这个字段） */
  ceo?: ProjectLeader | null
  /** 这块业务下的项目（含已归档），按创建时间排 */
  projects: Project[]
  counts: BusinessCounts
  lastEvent?: TimelineEvent
  updatedAt: IsoTime
}

// ───────────── 业务里的项目 ─────────────

/**
 * 业务 = 登记的文件夹（视频、网店、某个 App）。项目 = 业务下面由一个 Leader Agent 带的一条线：
 * 视频业务里的一个选题、App 的「运营」「构建」、网店的「后台监控」「SEO 优化」。
 * 分几个项目由老板定，不套模板；一个项目只有一个 Leader Agent，Leader Agent 再派下属。
 */
export type Project = {
  id: Id
  businessId: Id
  name: string
  /** 项目在业务目录里的子目录（相对路径，如 "选题/AI 省钱"）；空 = 整个业务目录 */
  dir?: string
  /** 绝对路径 = 业务 workspacePath + dir；Leader Agent 在这里开 */
  path: string
  status: 'active' | 'archived'
  /** 这个项目的 Leader Agent；还没开过为 null */
  leader: ProjectLeader | null
  counts: {
    /** 还开着的下属 Agent */
    workersLive: number
    /** 派单总数 / 已汇报数（Leader Agent 和下属的派单都算） */
    dispatches: number
    dispatchesDone: number
  }
  /** 定时巡检：到点给这个项目的 Leader 发一句话；没设过为空 */
  schedule?: ProjectSchedule
  /** HiveWard 预设的特殊项目（如 GitHub 巡检）；普通项目为空 */
  preset?: ProjectPreset
  createdAt: IsoTime
  updatedAt: IsoTime
}

/** 座位上坐的是谁：HiveWard 开的终端，或者一个桌面端 / 外部会话（HiveWard 打不进去，只读它的对话记录） */
export type SeatOccupant =
  | { kind: 'terminal'; terminal: string }
  | {
      kind: 'session'
      /** CLAUDE_CODE_SESSION_ID 等 */
      sessionId: string
      /** claude-desktop / claude（不在 HiveWard 终端里的 Claude Code）/ codex … */
      agent: AgentKind
      cwd: string
    }

/** 座位上的人（CEO 位、项目的 Leader 位共用） */
export type ProjectLeader = {
  native?: HivewardSeatRuntime
  crew?: HivewardCrewSnapshot
  /** 坐在终端里时：终端 handle；终端没了仍保留最后一个，liveness 为 exited。会话坐的没有 */
  terminal?: string
  /** 谁坐着（旧数据只有 terminal，读进来当 { kind: 'terminal' }） */
  occupant?: SeatOccupant
  agent: AgentKind
  model?: string
  liveness: Liveness
  /** 手上的活走到哪了，同 TopologyNode.state */
  state?: NodeState
  /** 正在做什么（最近一条派单的第一行） */
  activity?: string
  startedAt: IsoTime
}

// ───────────── 目标 / 任务 / 下属 ─────────────

export type ObjectiveStatus = 'draft' | 'sent' | 'running' | 'done' | 'failed'

/** Run 无 status：任务全 completed → done，有 failed → failed，其余（含空 Run）→ running。 */
export type Objective = {
  id: Id
  businessId: Id
  /** 对应 HiveWard Run；负责人建好 Run 前为空 */
  runId?: Id
  title: string
  status: ObjectiveStatus
  progress: { done: number; total: number }
  createdAt: IsoTime
  closedAt?: IsoTime
}

/** P0 实测及源码核对：HiveWard 六种 status 与此枚举同名透传；未知值报 hiveward_invalid_data，不猜测映射。 */
export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'blocked' | 'completed' | 'failed'

/** 下属完成任务时的汇报，对应 HiveWard worker_done 消息的字段。 */
export type TaskReport = {
  outcome: 'succeeded' | 'failed'
  /** 三句话的执行摘要 ← worker_done 消息的 body */
  summary: string
  reportedAt: IsoTime
  /** ← worker_done 的 --files-modified */
  filesModified?: string[]
  /** ← worker_done 的 --report-path */
  reportPath?: string
}

export type Task = {
  id: Id
  projectId?: Id
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
  /** ← task-list updated_at/completed_at，或 worker_done.created_at，最后回退任务 created_at（HiveWard 不提供其他更新时间）。 */
  updatedAt: IsoTime
  /** 派单方来自 Dispatch.creatorAddress / Run.coordinatorAddress；外部会话元数据由引擎登记；旧派单只读展示 */
  /** owner = 老板在架构图的老板卡上直接派给 Leader Agent 的 */
  dispatchedBy?: {
    kind: 'claude-desktop' | 'claude-code' | 'grok' | 'cli' | 'owner'
    id: Id
    label: string
    /** 原派单方所在机器；旧记录可能没有，远程授权必须拒绝缺字段记录 */
    machineId?: Id
  }
  /** 派单任务所在项目名（不属于任何业务时用来标注） ← 派单记录 project */
  project?: string
  /** 派单任务的终端还在时：它的 handle，点开能看实时输出 */
  terminal?: string
  /** 终端仍在跑的后台命令数 ← terminal.agentStatus；大于 0 才有，主 Agent 是否空闲仍看 status */
  backgroundCommands?: number
  /** 派单任务没汇报完时又补充的话（hiwd tell），按先后 */
  followUps?: string[]
  /** 派单任务交活后的复核（status 为 completed 后才有；复核前的旧派单没有） */
  review?: TaskReview
  /** 来自引擎 stopReason=errored 邮箱提醒，不结算任务 */
  errorStop?: ModelErrorStop
  /** 发给它的消息因为模型出错被 Agent 丢了（Kimi「Queued message dropped」）：恢复后要重发 */
  dropped?: DroppedMessage
  /** 旧记录的关终端说明；当前下属释放结果来自引擎，复核通过看 review */
  closed?: WorkerClosed
  /** dispatches.json 历史记录：只读，不参与复核、派单、待办计数 */
  historical?: boolean
}

/** 模型服务报错停下 ← 引擎 worker-turn-stop 提醒 */
export type ModelErrorStop = {
  /** quota 额度用完；rate_limit 被限流；overloaded 服务过载；auth 登录失效 / 认证失败；api 其他模型服务报错 */
  reason: 'quota' | 'rate_limit' | 'overloaded' | 'auth' | 'api'
  /** 屏幕上那行报错原文 */
  line: string
  /** 第一次看到这行报错的时间（终端屏幕上的实时判断没有） */
  at?: IsoTime
}

/** 被 Agent 丢掉的一条消息 */
export type DroppedMessage = {
  /** 屏幕上写的消息开头 */
  text: string
  at: IsoTime
}

/** 下属终端关了：manual 老板在网页上点 × 关的；idle 空闲 30 分钟自动关的 */
export type WorkerClosed = {
  reason: 'manual' | 'idle'
  at: IsoTime
}

/** POST /api/workers/:handle/close → 过几秒才真关，这段时间里 POST .../close/undo 能撤销 */
export type WorkerCloseResponse = {
  /** 真关的时间 */
  closeAt: IsoTime
}

/** POST /api/workers/:handle/close/undo；已经关掉了 undone 为 false */
export type WorkerCloseUndoResponse = {
  undone: boolean
}

/** 派单任务的复核：谁派的谁复核，老板能复核任何一条 */
export type TaskReview = {
  /** awaiting 完成·待复核；accepted 已通过（终端已关、已成工作记录）；rework 打回重做中 */
  state: 'awaiting' | 'accepted' | 'rework'
  /** 该谁复核：dispatcher = 派活的那个 Agent / 会话；owner = 老板 */
  reviewer: 'dispatcher' | 'owner'
  /** 最近一次复核意见（打回时必填） */
  note?: string
  by?: { kind: 'owner' | 'agent'; id: Id; label: string; machineId?: Id }
  at?: IsoTime
  /** 第几轮复核（交活后追加或打回开新轮时加一） */
  round: number
}

/** POST /api/tasks/:id/review */
export type ReviewTaskRequest = {
  verdict: 'accept' | 'rework'
  /** rework 必填，通过 orchestration.send 发往 dispatch 地址并创建后续 Task */
  note?: string
}
export type ReviewTaskResponse = {
  task: Task
  /** accept 时：生成的工作记录 */
  record?: WorkRecord
  /** 引擎释放回执；retained 表示引擎因 keep-open / 持有关系保留终端 */
  release?: { dispatchId: Id; state: string; reason?: string; processAction: string }
  /** 打回由原生 send 生成后续 Task；仍在干活时为原生消息回执。原 Task 保持结算结果。 */
  followUp?:
    | { state: string; taskId: Id; dispatchId: Id; runId: Id; followUpOf?: Id; delivery?: string }
    | { message: { id: Id } }
  closeError?: string
}

/** 工作记录：通过复核的一次派单（GET /api/records/:id） */
export type WorkRecord = {
  id: Id
  taskId: Id
  /** 复核轮次；旧记录缺省为第 1 轮。 */
  round?: number
  businessId?: Id
  projectId?: Id
  title: string
  prompt: string
  /** Agent 最后的汇报 */
  summary: string
  agent?: AgentKind
  dispatchedBy: { kind: string; id: Id; label: string; machineId?: Id }
  reviewedBy: { kind: 'owner' | 'agent'; id: Id; label: string; machineId?: Id }
  startedAt: IsoTime
  finishedAt: IsoTime
  acceptedAt: IsoTime
  /** 打回过几次 */
  reworks: number
  /** 能接着聊时才有：POST /api/records/:id/resume 在 cwd 开新终端接上这个会话 → ResumeRecordResponse */
  resume?: { agent: AgentKind; sessionId: string; cwd: string }
}
export type ResumeRecordResponse = {
  terminal: string
}

export type Worker = {
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
  /** ← HiveWard 进程 startTime / worker-show createdAt，或 HiveWard 负责人启动记录；无来源为空字符串。 */
  startedAt: IsoTime
}

// ───────────── 待我决定 ─────────────

export type DecisionSource = 'gate' | 'escalation' | 'question'
export type Urgency = 'high' | 'normal' | 'low'

export type Decision = {
  id: Id
  businessId: Id
  objectiveId?: Id
  taskId?: Id
  source: DecisionSource
  question: string
  /** 问题上方的小标题（Agent 提问框的「☐ 飞书应用」） */
  title?: string
  body?: string
  options: string[]
  /** 选项下面的说明：选项文字 → 说明 */
  optionDescriptions?: Record<string, string>
  /** 负责人给出的建议选项 ← 消息 payload.recommendation（Leader 简报要求填写） */
  recommendation?: string
  /** ← 消息 --priority；gate 默认 normal */
  urgency: Urgency
  state: 'pending' | 'resolved' | 'expired'
  /** 旧响应兼容字段；本批 gate 直接调用原生 gateResolve。 */
  delivery?: 'enqueued'
  /** 派单 Agent 停下来问的（它的回话里带【需要确认】）← 派单记录；答复会直接发回这个终端 */
  /** menu：Agent 停在终端选择菜单上，options 就是菜单项，选了直接替它按；free：菜单上有「自己写」那项，可以自定义回复 */
  dispatch?: {
    handle: string
    agent: AgentKind | null
    by: string
    menu?: boolean
    free?: boolean
  }
  /** Agent 附的截图地址（/api/shots/…） ← 它回话里 hiwd web screenshot 输出的路径 */
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
  /** 通过复核的工作记录 */
  | 'record'

/** GET /api/timeline?businessId=&cursor=&limit= → Page<TimelineEvent>，按时间倒序 */
export type TimelineEvent = {
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
  /** 属于业务里的哪个项目（能认出时） */
  projectId?: Id
  /** kind 为 record 时：工作记录 id */
  recordId?: Id
}

// ───────────── 指令 ─────────────

export type Instruction = {
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
 * 架构图：每块业务一组，根是业务节点（kind: business，id `business:<业务 id>`）。
 * 业务 → 它的每个项目各一个 Leader Agent（kind: leader，带 projectId，label 是项目名），
 * CEO 与 Grok Bot 同挂业务根；Leader 和下属按原生 crew 的管理关系投影。
 * 业务目录里开着、但不属于任何项目的 Agent，挂在一个 projectId 为空、label「未归项目」的 leader 下（没有就不出）。
 * 不属于任何业务的派单目录也是一组（unregistered: true），只有直连，没有 Grok。
 */
export type TopologyNode = {
  id: Id
  /** project 是旧版的业务根节点，新版改叫 business；网页两种都认，等局域网里没有旧版本后删 */
  kind: 'business' | 'project' | 'owner' | 'grok' | 'ceo' | 'leader' | 'worker'
  /** leader / worker：属于哪个项目 */
  projectId?: Id
  /** owner 是旧版老板节点的兼容占位：3a 后台起 topology 不再返回它，后续由前端清理后移除 */
  /** 不是登记过的项目，只是有人在这个目录里派过活 */
  unregistered?: boolean
  /** grok（Personal Agent 位）：那家产品里具体选了哪个 Agent（Grok Bot 里某个 Bot 的 id） */
  bot?: string
  /** 树结构：CEO 与 Grok Bot 同挂业务根；下属跟随原生 crew 的直接管理者 */
  parentId?: Id
  label: string
  sublabel?: string
  agent?: AgentKind
  liveness?: Liveness
  businessId?: Id
  /** 执行端 Worker 的远程来源；仅跨电脑派单时带 */
  dispatcherMachineId?: Id
  /** 派单端合成的远程 Worker：真实任务和终端都在这台执行机器上 */
  execution?: { machineId: Id; dispatchId: Id }
  federation?: {
    environmentId: Id
    name: string
    peerFingerprint: string
    pairingRevision?: number
    dispatchId: Id
  }
  nativeTerminal?: string
  /** 远程 Worker 的执行机器名称 ← 派单缓存 / 当前机器列表 */
  machineName?: string
  /** 远程执行机器 / 空降派单方当前是否在线；离线也保留最后已知节点 */
  online?: boolean
  /** 执行端的空降 CEO / Leader 影子：表示来源电脑上的原派单方，不是本机座位 */
  airborne?: {
    machineId: Id
    machineName: string
    dispatcherId: Id
    dispatcherLabel: string
    /** 来源电脑上的业务名；派单记录带有时才返回 */
    businessName?: string
  }
  /** 空降派单方在执行端派出的 root 下属数和派单 id；多机总览据此合并占位 */
  count?: number
  remoteChildren?: Id[]
  /** 跨业务外援的原属业务和身份；节点、派单与复核仍归发话方业务 */
  external?: {
    businessId: Id
    businessName: string
    projectId?: Id
    projectName?: string
    /** 接活方在原属业务里的身份 */
    role: 'ceo' | 'leader' | 'worker'
  }
  /** 正在做什么（当前任务标题或阶段）；空闲时为空 */
  activity?: string
  /** 当前任务的 id ← worker-list: workers[].taskId */
  taskId?: Id
  /** 下属的派发 id ← worker-list: workers[].dispatchId；用于读它的终端画面 */
  dispatchId?: Id
  /** 对应的 HiveWard 终端 ← terminal.list: handle；有它就能在详情里看这个 Agent 的对话、直接说话 */
  terminal?: string
  /** Leader Agent 是某个派单会话（比如在项目目录里开着的 Claude Code）时：它的派单方 id ← 派单记录 by.id，点开看它派出去的活 */
  dispatcher?: Id
  /** leader：和直连并联的那个 Grok Bot 节点的 id */
  via?: Id
  /** leader：这一行对应的目录（业务的 workspacePath 或项目路径），没经派单的 Agent 按它归行 */
  project?: string
  /** 最近一次心跳 / 活动时间；远程 Worker 是派单缓存最后刷新时间 */
  lastSeenAt?: IsoTime
  /** Agent 开始干的时间：派单任务取派单时间，Leader Agent / 终端取 Agent 进程启动时间；卡片第三行「运行 X」 */
  startedAt?: IsoTime
  /** 派单任务交了汇报的时间；有它时卡片显示「用时 X」 */
  finishedAt?: IsoTime
  /** 派单开出来的 Worker：复核状态（awaiting 时卡片显示「完成·待复核」）← 派单记录 review.state */
  review?: TaskReview['state']
  /** 派单开出来的 Worker：模型服务报错停下了 ← 派单记录 errorStop；卡片显示「出错停了」，不算空闲 */
  errorStop?: ModelErrorStop
  /** 座位是会话坐的（kind 为 ceo / leader）：网页按它读对话记录；这种没有 terminal */
  sessionId?: string
  /** 节点底部的一行指标，例如 ["任务 9/14", "待决定 1"] */
  stats?: string[]
  /** 需要老板注意（有待决定或负责人失联） */
  attention?: boolean
  /** 手上的活走到哪了：等接单 / 干活中 / 已完成（待验收）/ 等确认 / 失败 / 空闲 / 已退出 / 离线 */
  state?: NodeState
}

/** GET /api/dispatches：执行端按认证 LAN peer 过滤后的 root 派单投影。 */
export type RemoteDispatchProjection = {
  id: Id
  terminal: string
  projectId?: Id
  project: string
  agent?: AgentKind
  title: string
  status: TaskStatus
  report?: TaskReport
  review?: TaskReview
  by: NonNullable<Task['dispatchedBy']> & { cwd?: string }
  at: IsoTime
  updatedAt: IsoTime
}

export type RemoteDispatchListResponse = { dispatches: RemoteDispatchProjection[] }

/** POST /api/remote-wakes：来源机器只认 TLS peer，body 不含也不采信来源机器字段。 */
export type RemoteWakeRequest = {
  taskId: Id
  reviewRound: number
  reportKey: string
  title: string
  businessName?: string
  projectName?: string
  recipient: { kind: 'session' | 'terminal'; id: Id }
  report?: TaskReport
  worker?: { terminal: string }
}

/** offline：座位上登记的终端已经关了（离线 / 未上座），不是故障；只有引擎报错、失败才是 failed。 */
export type NodeState =
  | 'pending'
  | 'working'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'idle'
  | 'exited'
  | 'offline'

export type TopologyResponse = {
  nodes: TopologyNode[]
}

// ───────────── 聚合响应 ─────────────

export type OverviewResponse = {
  health: HiveWardHealth
  businesses: BusinessSummary[]
  decisionsPending: number
  recentEvents: TimelineEvent[]
}

export type BusinessDetailResponse = {
  business: BusinessSummary
  /** 负责人授权边界（登记业务时填写） */
  authority: string
  objectives: Objective[]
  tasks: Task[]
  workers: Worker[]
  decisions: Decision[]
  recentEvents: TimelineEvent[]
}

export type LeaderScreenResponse = HivewardWorkerReadMetadata & {
  text: string
  capturedAt: IsoTime
  /** Agent 自己的对话记录（找得到时），有就默认按对话显示 */
  items?: ChatItem[]
}

export type Page<T> = {
  items: T[]
  nextCursor: string | null
}

// ───────────── 现场：直连 HiveWard 终端（server/hiveward-bridge.mjs） ─────────────

/** ← terminal.list */
export type HiveWardTerminal = {
  handle: string
  /** 前台在跑的 Agent ← terminal.inspectProcess + 进程命令行；普通 shell 为 null */
  agent: 'codex' | 'claude' | 'kimi' | 'opencode' | null
  /** 跑着 Agent 时它的状态 ← terminal.agentStatus：working / idle / permission 等；Kimi 停在选择菜单上为 waiting（认屏幕） */
  status?: string
  /** 仍在跑的后台 shell / Monitor 等非 Agent 命令数 ← terminal.agentStatus；大于 0 才有，不把 idle 改成 working */
  backgroundCommands?: number
  title?: string | null
  /** 终端所在项目路径 */
  project: string
  branch?: string
  connected: boolean
  writable: boolean
  lastOutputAt?: number
  /** 前台 Agent 进程的启动时间 ← terminal.inspectProcess；不是 Agent 或查不到时省略 */
  startedAt?: IsoTime
  /** 屏幕最后一行 */
  preview: string
}

/** ← terminal.read --screen + terminal.agentStatus */
export type HiveWardScreen = {
  text: string
  capturedAt: IsoTime
  /** 终端进程还在 */
  running: boolean
  /** 终端里跑着 Agent 时：working / idle 等；停在选择菜单上（Kimi 不报状态时认屏幕）为 waiting；不是 Agent 时为 null */
  agent: string | null
  /** 仍在跑的后台命令数 ← terminal.agentStatus；大于 0 才有，Agent 已退出时省略 */
  backgroundCommands?: number
  /** Agent 停在选择菜单上等人选（Kimi「Approve this plan」、Claude「Do you want to proceed?」）← 认屏幕 */
  menu?: ScreenMenu
  /** Agent 停着、屏幕底部是模型服务报错（429、额度用完、过载、认证失败等）← 认屏幕 */
  errorStop?: ModelErrorStop
  /** 屏幕上 Kimi 报丢掉的排队消息（「Queued message dropped: …」后面那段） */
  dropped?: string[]
}

/** 终端里的选择菜单；cursor 是光标所在项的编号 */
export type ScreenMenu = {
  question: string
  /** 问题上方的小标题（Claude 提问框的「☐ 飞书应用」） */
  title?: string
  options: {
    n: number
    label: string
    /** 选项下面那几行说明 */
    description?: string
    /** Agent 推荐的那项（屏幕上写着 (Recommended)） */
    recommended?: boolean
    /** 让人自己写的那项（Type something.）：选它要带 text */
    free?: boolean
  }[]
  cursor: number
}

/** 选菜单第 n 项：桥会先确认菜单还在，再替 Agent 按键；菜单已经过去 → 409 menu_gone。选「自己写」那项要带 text */
export type ChooseMenuRequest = { n: number; text?: string }
export type ChooseMenuResponse = { option: { n: number; label: string } }

/** 对话视图里的一条：来自 Agent 自己的对话记录（codex rollout / claude projects / kimi wire） */
/** 对话里的一张图：图本身用 GET /api/chat-images/:id 取 */
export type ChatImage = { id: string; type: string }

export type ChatItem =
  | {
      id: string
      kind: 'user' | 'assistant' | 'thinking'
      text: string
      /** 老板贴的图（文字可能为空） */
      images?: ChatImage[]
      ts?: IsoTime
    }
  | {
      id: string
      kind: 'tool'
      tool: 'command' | 'read' | 'edit' | 'other'
      title: string
      output?: string
      /** 工具返回的截图 */
      images?: ChatImage[]
      status: 'running' | 'ok' | 'error'
      ts?: IsoTime
    }

export type HiveWardChat = HivewardWorkerReadMetadata & {
  /** 终端前台的 Agent；不是 Agent 时为 null */
  agent: 'codex' | 'claude' | 'kimi' | 'opencode' | null
  /** 对话记录文件；找不到时为 null，网页回退到终端视图 */
  source: string | null
  items: ChatItem[]
  /** Agent 自己列的任务清单（最后一版）；没列过 items 为空 */
  plan?: {
    items: { text: string; status: 'pending' | 'in_progress' | 'completed' }[]
    updatedAt: IsoTime | null
  }
}

/** ← repo.list */
export type HiveWardProject = {
  path: string
  name: string
}

export type HiveWardCreateTerminalRequest = {
  project: string
  /** 新开的 Agent 一律完全访问模式启动；opencode 只当下属，不能 role=leader */
  agent?: 'claude' | 'codex' | 'kimi' | 'opencode'
  /** 显式覆盖模型；Kimi 默认 kimi-code/k3.1-pro，OpenCode 默认 opencode-go/deepseek-v4.1-flash */
  model?: string
  title?: string
  /** leader：开出来当这一行的 Leader Agent，Claude Code 会带上 Leader Agent 的岗位说明 */
  role?: 'leader'
  /** 开在哪个项目里：终端在项目目录开，开出来的 Agent 归这个项目；role=leader 时成为这个项目的 Leader Agent */
  projectId?: Id
}

/**
 * 真终端的 WebSocket：GET /api/hiveward/terminals/:handle/stream?cols=&rows= 升级而来，全是 JSON 文本帧。
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
  /** claim：这个窗口正显示着，让终端按它的大小排版（不带只是登记大小，终端仍跟着别的窗口） */
  | { type: 'resize'; cols: number; rows: number; claim?: boolean }

export type HiveWardSendRequest = {
  text?: string
  /** 对话框里贴的图：POST /api/hiveward/images 存好的临时文件路径，先当作粘贴打进去再打字 */
  images?: string[]
  enter?: boolean
  agentPrompt?: boolean
  interrupt?: boolean
}

/** POST /api/hiveward/images（请求体是图片本身） */
export type HiveWardImageUpload = { path: string }

// ───────────── 请求体 ─────────────

export type CreateBusinessRequest = {
  name: string
  icon?: string
  workspacePath: string
  priority: 1 | 2 | 3
  leaderAgent: AgentKind
  leaderModel?: string
  /** 负责人授权边界，渲染进简报 */
  authority: string
}

/** 登记业务：目录必须存在，git / folder 自动判断 */
export type RegisterBusinessRequest = {
  path: string
  name?: string
}

/** 改业务：名字同步引擎 displayName */
export type UpdateBusinessRequest = {
  name?: string
  icon?: string
  status?: BusinessStatus
  leaderAgent?: AgentKind
  leaderModel?: string
  /** 换 Personal Agent 位上的那家；null 清空（同时清掉选的 Bot） */
  personalAgent?: PersonalAgentId | null
  /** 那家产品里具体哪个 Agent（Grok Bot 里某个 Bot 的 id）；null 清空 */
  personalAgentBot?: string | null
}

/** 在业务里新建项目；带 agent 就顺手开它的 Leader Agent（出口地区不合规时项目照建，Leader Agent 不开，返回 leaderError） */
export type CreateBusinessProjectRequest = {
  name: string
  /** 子目录（相对业务目录）；不存在就建 */
  dir?: string
  agent?: AgentKind
  model?: string
  /** 开出 Leader Agent 后发给它的第一句话 */
  prompt?: string
}

export type CreateBusinessProjectResponse = {
  project: Project
  /** 带了 agent 但没开成（比如 exit_region_blocked）时的原因 */
  leaderError?: { code: string; message: string }
}

/** 改项目：改名、归档 / 恢复（归档不关终端） */
export type UpdateBusinessProjectRequest = {
  name?: string
  status?: 'active' | 'archived'
}

/** 给项目开 Leader Agent：已有活着的 Leader Agent 时，不带 replace 就只把 prompt 发给它；replace=true 另开一个顶替（旧的不关） */
export type LaunchProjectLeaderRequest = {
  agent: AgentKind
  model?: string
  prompt?: string
  replace?: boolean
}

/**
 * POST /api/businesses/:id/workers：老板在架构图上直接派一个下属（Worker）。
 * 带 projectId 开在项目目录、挂在项目后面；不带就开在业务目录、挂在 CEO 后面。
 * 第一句话等 Agent 起来后自动发；派单记在老板名下，交活后由老板复核。只有老板（网页）能调。
 */
export type LaunchWorkerRequest = {
  /** 节点下派单须显式选座位；省略 / owner 为老板独立会话邮箱 */
  coordinator?: 'owner' | 'ceo' | 'leader'
  agent: string
  model?: string
  /** 让它做什么（第一句话） */
  prompt: string
  projectId?: Id
}
export type LaunchWorkerResponse = {
  terminal?: string
  dispatchId: Id
  taskId: Id
  runId: Id
  /** 引擎 worker-start 回执，不把失败或 outcome_unknown 当成功 */
  state: string
  identity: HivewardDispatcherIdentity
}

/** POST /api/workers/start：hiwd new；派单方由调用者身份解析，目录支持文件夹工作区 */
export type StartWorkerRequest = {
  path: string
  agent: string
  model?: string
  prompt: string
  projectId?: Id
}
export type StartWorkerResponse = LaunchWorkerResponse

/** POST /api/businesses/:id/ceo：开终端坐 CEO 位（同 Leader：已有人时不带 replace 只把 prompt 发给它） */
export type LaunchCeoRequest = LaunchProjectLeaderRequest

/** POST /api/seats/claim：会话自己坐上座位（hiwd seat 调用） */
export type ClaimSeatRequest = {
  seat: 'ceo' | 'leader'
  businessId: Id
  /** seat 为 leader 时必填 */
  projectId?: Id
  session: { sessionId: string; agent: AgentKind; cwd: string }
  /** 座位上已有人时：true 顶替（原来的只解绑，不关），false 返回 409 */
  replace?: boolean
}
export type ClaimSeatResponse = {
  /** 岗位说明全文：hiwd seat 打印出来给会话自己读 */
  brief: string
  seat: ProjectLeader
}
/** POST /api/seats/leave：离座，座位变空（不关终端 / 会话） */
export type LeaveSeatRequest = {
  seat: 'ceo' | 'leader'
  businessId: Id
  projectId?: Id
  /** 会话坐的：只有它本人能离座；终端坐的按调用者终端认 */
  sessionId?: string
}

export type CreateObjectiveRequest = {
  title: string
  brief: string
}

export type SendInstructionRequest = {
  body: string
  objectiveId?: Id
  /** 投递后再用 terminal send 唤醒负责人 */
  nudge?: boolean
}

/** POST /api/decisions/:id/resolve：question / escalation 调原生 reply；gate 调 gateResolve。
 * 使用 objectiveId 所属运行的真实 coordinator 身份。成功返回 resolved；原生拒绝直接返回错误。
 * needs-input 是原生提醒，不再提供屏幕菜单编号或向终端注入选择按键。
 */
export type ResolveDecisionRequest = {
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
  | { type: 'health'; health: HiveWardHealth }

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
/** 出口 IP 的一族（IPv4 或 IPv6）：IP 信息服务看到的 IP 和所在地 */
export type ExitIpEndpoint = {
  ip: string
  city: string | null
  region: string | null
  /** ISO 两位国家码 */
  country: string | null
  /** 运营商 / 机房，如「AS3257 GTT」 */
  org: string | null
}
/** 出口 IP（server/exit-ip.mjs）：用 Agent 的登录 shell 网络环境分别走 IPv4、IPv6 查；缓存 10 分钟 */
export type ExitIp = {
  v4: ExitIpEndpoint | null
  v6: ExitIpEndpoint | null
  /** IPv6 从另一个国家 / 地区出去（双栈分裂） */
  split: boolean
  checkedAt: IsoTime
  reason: string | null
}
export type AgentExitRegion = {
  /** ISO 两位国家码；未知为 null。只按它判断受限 Agent 能不能开 */
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
  /** 电脑卡片看的出口 IP 和所在地；还没测完或对方是旧版时没有 */
  exitIp?: ExitIp | null
  /** 电脑型号，如「MacBook Pro · Apple M3 Pro」；测不出或旧版没有 */
  model?: string | null
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
// 每台电脑都跑 HiveWard，彼此平等：任意一台都能看、能控制已配对的其他电脑。
// 本机 /api/m/:machineId/<路径> 原样转发到那台电脑的 /api/<路径>（走它的局域网端口 + 配对令牌）。

/** 局域网里的一台 HiveWard */
export type Machine = {
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
  /** 对方的 HiveWard 版本 */
  version?: string
  /** 成员通道已加密并核对过证书指纹；本机表示已启用 TLS；未配对或旧成员为 false */
  secure?: boolean
  /** TLS 指纹变化、旧成员需要重入或连接错误；不得静默回退 HTTP */
  error?: { code: string; message: string }
  /** 系统：darwin / win32 / linux */
  platform?: string
  /** 这台电脑所在的组织（本机、成员、以及局域网里发现的电脑都带，发现广播里的公开信息）；旧版本不带 */
  organization?: { id: Id; name: string; members: number }
  /** 在线时顺带取的概况，离线或没配对时为空 */
  summary?: {
    hivewardReachable: boolean
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
  /**
   * invite：组织这边邀请对方加入（对方同意）；request：对方申请加入这边的组织（组织这边同意）。旧版本不带，按 invite。
   * direction 是相对本机：sent 是本机发起的，incoming 是对方发起、等本机同意的。
   */
  kind?: 'invite' | 'request'
  direction: 'sent' | 'incoming'
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled'
  /** user / name 是对方声明的身份，address 是接收端观察到的地址；UI 必须展示远控授权警告 */
  machine: { id: Id; name: string; address: string; user?: string }
  organization: { id: Id; name: string }
  expiresAt: IsoTime
  /** 6 位确认码：双方证书指纹、邀请 id、双方随机数的 SHA-256 派生；先提交摘要再揭示，必须在两台屏幕核对后同意 */
  verifyCode: string
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
/** 设置 → 常规：定时巡检 */
export type PatrolSettings = {
  /** 巡检终端这一轮结束后空闲多久自动关（分钟，10–1440） */
  idleCloseMinutes: number
}

export type MachinesResponse = {
  machines: Machine[]
  /** 本机所在的组织：始终有一个，默认以本机建（名字「<电脑名>的组织」）；旧版本可能为 null */
  organization: MachineOrganization | null
  invitations: MachineInvitation[]
  /** 离线成员未收到撤销的数量；大于 0 时不得宣称全组织已解除控制 */
  pendingRemovals: number
  /** 离线成员待接收的新成员凭据数量，恢复在线后自动重试 */
  pendingMembers: number
  /** 组织改名尚未同步到的成员数量 */
  pendingOrganizationUpdates: number
  organizationNotices: MachineOrganizationNotice[]
  /** 本机局域网发现的状态；没开局域网时为 null */
  discovery?: MachineDiscoveryStatus | null
}

/** 发现端口占没占上、上一轮广播发出去几个包。端口没占上或有包被系统拒发时界面提示（Mac 多半是没给「本地网络」权限） */
export type MachineDiscoveryStatus = {
  listening: boolean
  bindError: string | null
  lastAnnounceAt: IsoTime | null
  delivered: number
  failed: number
  /** 上一轮有包被系统拒发（不是网络不通）：Mac 没给「本地网络」权限、防火墙拦了 */
  blocked: boolean
  sendError: string | null
}

/** POST /api/machines/invite → MachineInvitation。machineId（发现列表）或 address（手动 host:port）。
 * POST /api/machines/join 同形状 → MachineInvitation（kind: 'request'）：本机申请加入那台电脑所在的组织，
 * 那台（或组织里任一在线成员）同意后本机加入，原来的组织自动退出；双方屏幕同样显示 verifyCode 核对。 */
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

// ───────────── 跨电脑文件 ─────────────

/**
 * 每台电脑只开放自己设定的「共享目录」给组织里的电脑和本机 Agent 读写。
 * 路径一律用目标电脑自己的格式（Windows 是 D:\\视频\\a.mp4），由目标电脑校验：
 * 绝对路径、不准 ..、先解析软链 / junction 再判断必须落在共享目录里；隐藏目录和系统目录不列。
 * 别的电脑经 /api/m/<机器>/files/… 访问，只走加密且核对过证书的组织通道（Machine.secure），明文一律拒绝。
 */
export type FileRoot = {
  id: Id
  /** 显示名：业务名、收件箱、下载、D 盘… */
  label: string
  path: string
  kind: 'business' | 'inbox' | 'home' | 'drive' | 'custom'
  /** 别的电脑能不能往里写 */
  writable: boolean
}

export type FileEntry = {
  name: string
  /** 目标电脑格式的绝对路径 */
  path: string
  type: 'file' | 'dir'
  /** 文件字节数；目录为空 */
  size?: number
  modifiedAt: IsoTime
}

/** GET /api/files/roots */
export type FileRootsResponse = {
  roots: FileRoot[]
  /** 别人推过来、没指定目录时落在这里 */
  inbox: string
  /** 目标电脑的系统，网页按它拼路径分隔符 */
  platform: string
  /** 单个文件上限（字节） */
  maxBytes: number
}

/** GET /api/files/list?path= ：只列一层，目录在前，按名字排；超过上限截断 */
export type FileListResponse = {
  path: string
  /** 上一级（还在共享目录里时）；到共享目录根为 null */
  parent: string | null
  entries: FileEntry[]
  truncated: boolean
}

/**
 * GET /api/files/read?path=&inline=0|1 ：原样返回文件内容（流式，支持 Range），content-disposition 带文件名；
 *   inline=1 时白名单类型可预览，响应头 x-file-mtime（毫秒整数）/ x-file-size 用于版本和大小。
 * POST /api/files/write?path=<目标文件>&overwrite=0|1&expectMtime=<毫秒> ：请求体是文件原始字节（流式），父目录不存在就建；
 *   已存在且 overwrite=0 → 409 file_exists；expectMtime 不一致 → 409 file_changed，error.mtime 是当前版本。
 *   不带 path 时写进收件箱（文件名用 x-hiveward-filename 头）。
 * POST /api/files/mkdir { path } → { path }
 */
export type FileWriteResponse = {
  path: string
  size: number
  /** 写入后的文件修改时间（毫秒整数），下次可用 expectMtime 做冲突检查 */
  mtime: number
}

/** GET / POST /api/files/settings：本机共享哪些目录；只能在本机改，别的电脑来改一律 403 */
export type FileShareSettings = {
  /** 额外共享的目录（业务目录和收件箱默认共享，不用列） */
  roots: { path: string; label?: string; writable: boolean }[]
  /** 收件箱位置；默认 ~/HiveWard 收件箱 */
  inbox: string
  /** 别的电脑上的 Agent 往这台写：只能写收件箱 / 共享目录都能写 / 不准写 */
  agentWrite: 'inbox' | 'roots' | 'none'
}

// ───────────── Grok Bot（只读本机 Grok Bot 桌面端的缓存） ─────────────

/** Grok Bot 的 11 种颜色（和它的头像编辑器一致） */
export type GrokBotColor =
  | 'black'
  | 'brown'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'violet'
  | 'magenta'
  | 'gray'

/** 形状名照 Grok Bot 原样（blob / pebble / squircle / tablet / wedge / hex / cloud / teardrop / heart …），认不出的网页按 blob 画 */
export type GrokBotShape = string

export type GrokBot = {
  id: string
  name: string
  description?: string
  /** 已经按 Grok Bot 的规则算好：用户没选时按 Bot id 推出默认形状和颜色 */
  shape: GrokBotShape
  color: GrokBotColor
  createdAt: IsoTime
  lastActivityAt?: IsoTime
  unreadCount: number
  /** Bot 停下来等你回复 */
  awaitingYou: boolean
  /** 最后一条消息的纯文本预览（≤ 200 字） */
  lastMessage?: string
  /** 语音角色（liora 等），没设省略 */
  voice?: string
}

export type GrokBotsResponse = {
  /** 本机装了 Grok Bot */
  installed: boolean
  /** 桌面端正在运行 */
  running: boolean
  signedIn: boolean
  /** 主 Bot（名字叫 Grok Bot 的那个）在前，其余按最近活动排 */
  bots: GrokBot[]
}

export type GrokBotMessage = {
  id: string
  from: 'you' | 'bot'
  /** text：文字；choice：让你选的卡片（text 是问题，options 是选项）；attachment：附件（text 是文件名）；call：语音通话（text 是通话摘要） */
  kind: 'text' | 'choice' | 'attachment' | 'call'
  text: string
  options?: string[]
  at: IsoTime
}

/** 最近的对话（Grok Bot 本地只缓存最近一段，最多 200 条），旧的在前 */
export type GrokBotMessagesResponse = { messages: GrokBotMessage[] }

// ───────────── 跨电脑 MCP 转接 ─────────────

/**
 * 这台电脑把本机的 MCP 服务器（stdio 命令或本机 HTTP 地址）共享给组织里的其他电脑。
 * 别的电脑上的 Agent 把 `hiwd mcp <名字> --on <这台>` 配成自己的 MCP 命令，消息经加密通道转到这台，由这台起进程 / 连地址。
 * 默认不共享；只能在本机改；消息内容不进日志和时间线，只记谁连上 / 断开。
 */
export type McpShare = {
  /** 唯一，小写字母数字和 -（如 myapp） */
  name: string
  description?: string
  enabled: boolean
  transport: 'stdio' | 'http'
  /** stdio：可执行文件和参数（不经 shell）；Windows 上 .cmd / .bat 由后台处理 */
  command?: string
  args?: string[]
  cwd?: string
  /** 环境变量只返回名字，值不离开本机 */
  envKeys?: string[]
  /** http：本机地址（只允许 127.0.0.1 / localhost / [::1]） */
  url?: string
  /** 允许哪些电脑用（机器 id）；空 = 组织里所有电脑 */
  allowMachines?: Id[]
  /** 现在连着的会话数 */
  sessions: number
}

/** POST /api/mcp/shares：新建或改一个共享（按 name）；env 不传 = 保留原来的值，传了整体替换 */
export type SaveMcpShareRequest = Omit<McpShare, 'envKeys' | 'sessions'> & {
  env?: Record<string, string>
}

/** GET /api/mcp/available：这台电脑共享给调用方的 MCP（经 /api/m/<机器>/ 调就是看那台的） */
export type McpAvailable = {
  name: string
  description?: string
  transport: McpShare['transport']
}

/**
 * WebSocket /api/mcp/:name/connect：一条连接 = 一个 MCP 会话。
 * 双方都发文本帧，每帧一条 JSON-RPC 消息原样转发；共享方收到连接时起进程（stdio）或连地址（http），连接断了就关掉。
 * 连不上 / 被拒时服务端发一帧 McpConnectError 再关闭。
 */
export type McpConnectError = {
  type: 'error'
  code: 'not_shared' | 'disabled' | 'forbidden' | 'start_failed' | 'too_many_sessions'
  message: string
}

// ───────────── 跨电脑剪贴板 ─────────────

/**
 * 一台复制、另一台粘贴：组织里打开了同步的电脑之间互相推剪贴板（文字、图片、文件）。
 * 两边都要打开才生效；只走加密通道；密码管理器标成隐藏 / 临时的内容一律不推；
 * 剪贴板内容不写进时间线和日志，只记「从哪台收到了什么类型」。
 */
export type ClipboardSettings = {
  /** 默认关 */
  enabled: boolean
  /** 复制的文件总大小不超过这个就直接传过去放进对方剪贴板；超过只提醒去「文件」里收 */
  maxFileBytes: number
}

export type ClipboardEvent = {
  direction: 'sent' | 'received'
  machine: { id: Id; name: string }
  kind: 'text' | 'image' | 'files'
  /** 文件个数 */
  count?: number
  bytes?: number
  at: IsoTime
  /** 没同步的原因：隐藏内容 / 文件太大 / 对方没开 / 通道没加密… */
  skipped?: string
}

/** GET /api/clipboard */
export type ClipboardStatus = {
  settings: ClipboardSettings
  /** 最近 20 条，新的在前 */
  recent: ClipboardEvent[]
}

/** 成员间 POST /api/clipboard/push；只允许 TLS 认证成员调用，origin 必须等于已认证成员 id */
export type ClipboardPush = {
  /** 接收去重及防回声用的随机事件 id */
  eventId: Id
  origin: Id
} & (
  | { kind: 'text'; text: string; html?: string; rtf?: string }
  | { kind: 'image'; /** PNG 字节的 base64；不进入 recent、日志或时间线 */ png: string }
)

export type ClipboardFileEntry = {
  /** 以 / 分隔的相对路径；禁止绝对路径、..、隐藏项和反斜杠 */
  path: string
  type: 'file' | 'directory'
  /** type=file 时必填；目录不传 */
  size?: number
}

/** 成员间 POST /api/clipboard/files：先建会话，再逐项目流式上传，最后 commit */
export type ClipboardFileManifest = {
  eventId: Id
  origin: Id
  kind: 'files'
  /** 顶层文件/目录数量 */
  count: number
  totalBytes: number
  entries: ClipboardFileEntry[]
}

/** 文件超限时只发这个提醒，绝不发送文件清单或正文 */
export type ClipboardNotice = {
  eventId: Id
  origin: Id
  kind: 'files'
  reason: 'files_too_large'
  count: number
  bytes: number
}

// ───────────── 路由表 ─────────────

export const endpoints = {
  overview: { method: 'GET', path: '/api/overview' },
  businessDetail: { method: 'GET', path: '/api/businesses/:id' },
  workerScreen: { method: 'GET', path: '/api/workers/:dispatchId/screen' },
  hivewardTerminals: { method: 'GET', path: '/api/hiveward/terminals' },
  hivewardProjects: { method: 'GET', path: '/api/hiveward/projects' },
  hivewardScreen: { method: 'GET', path: '/api/hiveward/terminals/:handle/screen' },
  hivewardChat: { method: 'GET', path: '/api/hiveward/terminals/:handle/chat' },
  hivewardSend: { method: 'POST', path: '/api/hiveward/terminals/:handle/send' },
  hivewardChoose: { method: 'POST', path: '/api/hiveward/terminals/:handle/choose' }, // ChooseMenuRequest → ChooseMenuResponse
  hivewardCreate: { method: 'POST', path: '/api/hiveward/terminals' },
  hivewardClose: { method: 'POST', path: '/api/hiveward/terminals/:handle/close' },
  registerBusiness: { method: 'POST', path: '/api/businesses' }, // RegisterBusinessRequest → { business }
  updateBusiness: { method: 'PATCH', path: '/api/businesses/:id' }, // UpdateBusinessRequest → { business }
  harnesses: { method: 'GET', path: '/api/harnesses' }, // ?refresh → HarnessesResponse
  chatImage: { method: 'GET', path: '/api/chat-images/:id' }, // 二进制图片
  usage: { method: 'GET', path: '/api/usage' }, // UsageResponse；只有桌面 App 有，别处 404
  quota: { method: 'GET', path: '/api/quota' }, // QuotaResponse：哪家额度用完、几个下属停着
  quotaSettings: { method: 'POST', path: '/api/quota/settings' }, // QuotaSettingsRequest → { autoResume }
  closeWorker: { method: 'POST', path: '/api/workers/:handle/close' }, // → WorkerCloseResponse；5 秒后真关
  undoCloseWorker: { method: 'POST', path: '/api/workers/:handle/close/undo' }, // → WorkerCloseUndoResponse
  refreshUsage: { method: 'POST', path: '/api/usage/refresh' }, // UsageResponse
  businessLogo: { method: 'GET', path: '/api/businesses/:id/logo' }, // ?v=<logo 文件 mtime>，二进制图片
  deleteBusiness: { method: 'DELETE', path: '/api/businesses/:id' }, // 从引擎移除（不删磁盘文件），记录标 removedAt
  businessProjects: { method: 'GET', path: '/api/businesses/:id/projects' }, // → { projects: Project[] }
  createBusinessProject: { method: 'POST', path: '/api/businesses/:id/projects' }, // CreateBusinessProjectRequest → CreateBusinessProjectResponse
  updateBusinessProject: { method: 'PATCH', path: '/api/businesses/:id/projects/:projectId' }, // UpdateBusinessProjectRequest → { project }
  launchProjectLeader: { method: 'POST', path: '/api/businesses/:id/projects/:projectId/leader' }, // LaunchProjectLeaderRequest → { project, terminal }
  launchWorker: { method: 'POST', path: '/api/businesses/:id/workers' }, // LaunchWorkerRequest → LaunchWorkerResponse（只限老板）
  launchCeo: { method: 'POST', path: '/api/businesses/:id/ceo' }, // LaunchCeoRequest → { business, terminal }
  claimSeat: { method: 'POST', path: '/api/seats/claim' }, // ClaimSeatRequest → ClaimSeatResponse（座位有人且不 replace → 409）
  leaveSeat: { method: 'POST', path: '/api/seats/leave' }, // LeaveSeatRequest → { seat: null }
  createObjective: { method: 'POST', path: '/api/businesses/:id/objectives' },
  sendInstruction: { method: 'POST', path: '/api/businesses/:id/instructions' },
  decisions: { method: 'GET', path: '/api/decisions' }, // ?state=pending
  resolveDecision: { method: 'POST', path: '/api/decisions/:id/resolve' },
  timeline: { method: 'GET', path: '/api/timeline' }, // ?businessId=&projectId=&cursor=&limit= → Page<TimelineEvent>
  tasks: { method: 'GET', path: '/api/tasks' }, // ?businessId=&projectId=&status=（不传为全部业务，含已完成任务的汇报）
  reviewTask: { method: 'POST', path: '/api/tasks/:id/review' }, // ReviewTaskRequest → ReviewTaskResponse（Agent 只能复核自己派的；/api/m/ 转发只限老板）
  workRecord: { method: 'GET', path: '/api/records/:id' }, // → WorkRecord
  resumeRecord: { method: 'POST', path: '/api/records/:id/resume' }, // → ResumeRecordResponse
  topology: { method: 'GET', path: '/api/topology' }, // ?businessId=（不传为公司级：老板 → 全部负责人 → 全部在岗下属）
  events: { method: 'GET', path: '/api/events' }, // SSE
  machines: { method: 'GET', path: '/api/machines' },
  exitRegion: { method: 'GET', path: '/api/exit-region' },
  refreshExitRegion: { method: 'POST', path: '/api/exit-region/refresh' },
  exitRegionPolicy: { method: 'GET', path: '/api/exit-region/policy' },
  setExitRegionPolicy: { method: 'POST', path: '/api/exit-region/policy' },
  inviteMachine: { method: 'POST', path: '/api/machines/invite' },
  requestJoin: { method: 'POST', path: '/api/machines/join' }, // MachineInviteRequest → MachineInvitation（kind: 'request'）
  acceptMachineInvite: { method: 'POST', path: '/api/machines/invitations/:id/accept' },
  rejectMachineInvite: { method: 'POST', path: '/api/machines/invitations/:id/reject' },
  cancelMachineInvite: { method: 'POST', path: '/api/machines/invitations/:id/cancel' },
  leaveOrganization: { method: 'POST', path: '/api/machines/organization/leave' },
  renameOrganization: { method: 'POST', path: '/api/machines/organization/rename' },
  renameMachine: { method: 'POST', path: '/api/machines/:id/rename' }, // { name }
  removeMachine: { method: 'POST', path: '/api/machines/:id/remove' },
  fileRoots: { method: 'GET', path: '/api/files/roots' }, // → FileRootsResponse
  fileList: { method: 'GET', path: '/api/files/list' }, // ?path= → FileListResponse
  fileRead: { method: 'GET', path: '/api/files/read' }, // ?path= → 文件字节（Range）
  fileWrite: { method: 'POST', path: '/api/files/write' }, // ?path=&overwrite= 原始字节 → FileWriteResponse
  fileMkdir: { method: 'POST', path: '/api/files/mkdir' }, // { path } → { path }
  fileSettings: { method: 'GET', path: '/api/files/settings' }, // → FileShareSettings（POST 同形状改，只限本机）
  mcpShares: { method: 'GET', path: '/api/mcp/shares' }, // → McpShare[]（只限本机）
  saveMcpShare: { method: 'POST', path: '/api/mcp/shares' }, // SaveMcpShareRequest → McpShare（只限本机）
  removeMcpShare: { method: 'POST', path: '/api/mcp/shares/:name/remove' }, // → { ok: true }（只限本机）
  mcpAvailable: { method: 'GET', path: '/api/mcp/available' }, // → McpAvailable[]（组织成员可调）
  mcpConnect: { method: 'GET', path: '/api/mcp/:name/connect' }, // WebSocket，见 McpConnectError
  grokBots: { method: 'GET', path: '/api/grok/bots' }, // → GrokBotsResponse（只限本机）
  grokBotMessages: { method: 'GET', path: '/api/grok/bots/:id/messages' }, // ?limit=50 → GrokBotMessagesResponse（只限本机）
  clipboard: { method: 'GET', path: '/api/clipboard' }, // → ClipboardStatus
  clipboardSettings: { method: 'POST', path: '/api/clipboard/settings' }, // ClipboardSettings → ClipboardStatus（只限本机）
  clipboardPush: { method: 'POST', path: '/api/clipboard/push' }, // 成员间：ClipboardPush
  clipboardNotice: { method: 'POST', path: '/api/clipboard/notice' }, // 成员间：ClipboardNotice
  clipboardFiles: { method: 'POST', path: '/api/clipboard/files' }, // 成员间：ClipboardFileManifest
  clipboardFileEntry: { method: 'POST', path: '/api/clipboard/files/:eventId/entry?index=' }, // 成员间：原始文件字节
  clipboardFileDirectory: {
    method: 'POST',
    path: '/api/clipboard/files/:eventId/directory?index='
  }, // 成员间：建空目录
  clipboardFileCommit: { method: 'POST', path: '/api/clipboard/files/:eventId/commit' }, // 成员间：完整后原子应用
  onMachine: { method: 'ANY', path: '/api/m/:machineId/*' } // 转发到那台电脑的 /api/*
} as const

// ───────────── 本机的 Agent（Harness） ─────────────

/** Personal Agent：常驻的 AI 同事，坐业务的 Personal Agent 位 */
export type PersonalAgentId = 'grokbot' | 'hermes' | 'openclaw' | 'muse'

/** 本机认出来的一家 Agent：personal 是常驻的 AI 同事，coding 是写代码的命令行 */
export type Harness = {
  id: string
  name: string
  kind: 'personal' | 'coding'
  /** 做它的公司（只有 Personal Agent 有） */
  maker?: string
  installed: boolean
  /** 桌面 App 的位置和版本 */
  app?: string
  version?: string
  /** 命令行 */
  command?: string
}

/** GET /api/harnesses（?refresh 重新认一遍） */
export type HarnessesResponse = {
  /** 认得的几家都列出来，没装的 installed 为 false */
  personal: (Harness & { id: PersonalAgentId })[]
  /** 只列装了的 */
  coding: Harness[]
  checkedAt: IsoTime
  /** 命令行没认出来（引擎没开等）的原因 */
  error?: string
}

// ───────────── 用量（只在 HiveWard 桌面 App 里有） ─────────────

/** 一个额度窗口：用了百分之几、什么时候重置 */
export type UsageWindow = { label: string; usedPercent: number; resetsAt?: IsoTime }

/** 一家 Agent 的用量（数据来自引擎，和 HiveWard 状态栏同一份） */
export type ProviderUsage = {
  id: string
  name: string
  /** 套餐，例如 max、plus */
  plan?: string
  status: 'idle' | 'fetching' | 'ok' | 'error'
  error?: string
  windows: UsageWindow[]
  updatedAt?: IsoTime
}

/** 一家 Agent 额度用完的提示（顶栏、hiwd new 警告）← GET /api/quota */
export type QuotaAlert = {
  agent: 'claude' | 'codex' | 'kimi'
  /** Claude / Codex / Kimi */
  name: string
  /** 引擎显示有窗口用满了；引擎读不到这家额度、但有下属撞上了额度报错时也为 true */
  exhausted: boolean
  /** 大约几点恢复（用满的窗口里最晚的 resetsAt）；读不到时没有 */
  resetsAt?: IsoTime
  /** 因为这家额度停着的下属个数 */
  stopped: number
  /** 这些下属的终端 handle */
  handles: string[]
}

/** GET /api/quota：只列有问题的那几家；没问题时 providers 为空 */
export type QuotaResponse = {
  providers: QuotaAlert[]
  /** 设置「额度恢复后自动继续」：恢复后自动给停下的下属发「接着做」，丢掉的消息一并重发；默认开 */
  autoResume: boolean
}

/** POST /api/quota/settings（只限本机）→ { autoResume } */
export type QuotaSettingsRequest = { autoResume: boolean }

/** GET /api/usage、POST /api/usage/refresh */
export type UsageResponse = {
  /** 引擎还没算出来时为 false */
  available: boolean
  providers: ProviderUsage[]
}

/** 本机 HiveWard 正式版更新快照；读取不会检查外网、下载或退出应用。 */
export type HiveWardUpdateSnapshot = {
  /** 当前电脑上正在工作的 Agent 数量，安装确认前重新读取。 */
  workingAgents: number
  appVersion: string
  automatic: boolean
  notes: string
  status: {
    state:
      | 'idle'
      | 'checking'
      | 'available'
      | 'not-available'
      | 'downloading'
      | 'downloaded'
      | 'error'
    version?: string
    percent?: number
    message?: string
  }
}
export type MigrationNotice = {
  status: 'current' | 'migrated' | 'initialized' | 'deferred' | 'failed'
  path: string | null
  reason?: string
  backup?: string | null
}

/** 外部派单方只持有会话邮箱，不开代理终端，不借用 CEO / Leader。 */
export type HivewardDispatcherIdentity = {
  address: string
  sessionId?: string
}
/** POST /api/orchestration/session；身份由调用者请求头确定，body 只指定工作目录。 */
export type HivewardSessionRequest = {
  path: string
}

/** GET /api/inbox/wait?timeout=<秒>；使用同一派单方请求头。保留原生 deliveryId，交给 check --ack 确认。 */
export type HivewardInboxResponse = {
  runId?: Id
  deliveryId?: Id | null
  messages: { id: Id; type: string; subject: string; body: string; payload?: string | null }[]
  text: string
  timedOut?: boolean
}
