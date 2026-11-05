import type { Id, AgentKind, IsoTime } from './api'

export type HivewardSeatRuntime = {
  party: { address: string; sessionId?: string }
  runId: Id
  dispatchId?: Id
  dispatcher?: { address: string; sessionId?: string }
}

/** POST /api/workers/start；跨实例仍发到派单电脑，由原生 environment 选择执行端。 */
export type HivewardWorkerStartRequest = {
  path: string
  agent: AgentKind
  prompt: string
  model?: string
  on?: string
  dispatcherPath?: string
}

/** POST /api/workers/:dispatchId/tell；通过原生 Dispatch 邮件投递及生成后续 Task。 */
export type HivewardWorkerTellRequest = { text: string }

/** 项目定时由原生 automations 执行；业务数据只保存 automationId，返回值投影原生记录。 */
export type ProjectSchedule = {
  /** 原生 automation 唯一记录；业务层只保存引用。 */
  automationId?: string
  agentRequired?: boolean
  rrule?: string
  dtstart?: number
  timezone?: string
  agentId?: string
  enabled: boolean
  /** 不填是 timer */
  trigger?: 'timer' | 'github'
  /** 间隔分钟：timer 10–1440，github 1–60 */
  everyMinutes?: number
  /** 发给 Leader 的话（github 触发时后面接新动静清单） */
  message: string
  /** 上一轮还在干活就跳过这一轮（原生前置检查） */
  skipWhileBusy?: boolean
  /** github 触发时：owner/name */
  repo?: string
  /** 上一轮的时间 */
  lastRunAt?: IsoTime
  /**
   * 上一轮：sent 发出去了 / busy Leader 在忙，跳过（timer）/ queued Leader 在忙，排队等它空闲（github）/
   * quiet 没有新动静（github）/ vacant 没有能发进去的 Leader 终端 / failed 出错（原因见 lastError）
   */
  lastResult?: 'sent' | 'busy' | 'queued' | 'quiet' | 'vacant' | 'failed'
  lastError?: string
  /** 下一轮预计时间（enabled 时） */
  nextRunAt?: IsoTime
}

/** PUT /api/businesses/:id/projects/:pid/schedule → { project: Project }；enabled=false 停掉（保留设置） */
export type SetProjectScheduleRequest = {
  /** 新客户端直接提供原生 cron / recurrence；旧 everyMinutes 转成原生分钟 recurrence。 */
  rrule?: string
  dtstart?: number
  timezone?: string
  agentId?: string
  enabled: boolean
  trigger?: 'timer' | 'github'
  everyMinutes?: number
  message: string
  /** 不填 = 跳过 */
  skipWhileBusy?: boolean
  /** 套用的预设项目；null 取消 */
  preset?: ProjectPreset | null
  repo?: string
}

/** HiveWard 预设好的特殊项目 */
export type ProjectPreset = 'github'

/** 终端当前画面 ← terminal read --screen（负责人）/ orchestration worker-read（下属） */
export type HivewardWorkerReadMetadata = {
  /** 完整原生 workerRead 回包，包含 transcript / terminal、归档及进程归属证据。 */
  native?: unknown
  cursor?: string | number | null
  limited?: boolean
  fallbackReason?: string | null
  warnings?: string[]
}

export type HivewardCrewRow = {
  partyKey: string
  role: 'manager' | 'worker' | 'peer'
  label: string
  agentKind: string
  status: string
  sendAddress?: string
  task?: { title: string; state: string }
  openTarget?:
    | { kind: 'terminal'; handle: string }
    | { kind: 'dispatch'; address: string }
    | { kind: 'chat'; sessionId: string; worktreeId: string }
}

export type HivewardCrewSnapshot = {
  status: 'ok' | 'unknown'
  sections: {
    managedBy: HivewardCrewRow[]
    managing: HivewardCrewRow[]
    talkingWith: HivewardCrewRow[]
  }
}
