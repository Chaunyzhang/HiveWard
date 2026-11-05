import type {
  AgentKind,
  Liveness,
  ModelErrorStop,
  NodeState,
  TimelineKind,
  Urgency,
} from '@shared/api'
import { locale, tr } from '@/lib/i18n'

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) {
    return tr('刚刚')
  }
  const m = Math.round(s / 60)
  if (m < 60) {
    return tr('{0} 分钟前', [m])
  }
  const h = Math.round(m / 60)
  if (h < 24) {
    return tr('{0} 小时前', [h])
  }
  return tr('{0} 天前', [Math.round(h / 24)])
}

/** 两个时间点之间有多久：45 秒 / 12 分钟 / 1 小时 5 分 / 2 天 3 小时 */
export function duration(from: string, to?: string, now = Date.now()): string {
  const end = to ? new Date(to).getTime() : now
  const s = Math.max(0, Math.round((end - new Date(from).getTime()) / 1000))
  if (s < 60) {
    return tr('{0} 秒', [s])
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return tr('{0} 分钟', [m])
  }
  const h = Math.floor(m / 60)
  if (h < 24) {
    return m % 60 ? tr('{0} 小时 {1} 分', [h, m % 60]) : tr('{0} 小时', [h])
  }
  return h % 24
    ? tr('{0} 天 {1} 小时', [Math.floor(h / 24), h % 24])
    : tr('{0} 天', [Math.floor(h / 24)])
}

export const livenessStyle: Record<Liveness, { dot: string; label: string }> = {
  live: { dot: 'bg-live', label: tr('在线') },
  unverifiable: { dot: 'bg-attention', label: tr('无法确认') },
  exited: { dot: 'bg-muted-foreground/50', label: tr('已退出') },
}

/**
 * Agent 的几种状态，全界面同一套颜色：干活蓝、完成绿、故障红、等待橙黄、空闲灰；
 * 额度用完停下（quota）橙黄空心，和要你管的「等待」、真出错的「故障」分开。
 * 架构图节点、控制台标题、终端标签、侧栏圆点都用它。
 */
export type AgentStatus =
  | 'working'
  | 'done'
  | 'failed'
  | 'waiting'
  | 'idle'
  | 'quota'
  | 'offline'

export const agentStatusStyle: Record<
  AgentStatus,
  { label: string; dot: string; chip: string; pulse?: boolean }
> = {
  working: {
    label: tr('干活'),
    dot: 'bg-working',
    chip: 'bg-working/15 text-working',
    pulse: true,
  },
  done: { label: tr('完成'), dot: 'bg-done', chip: 'bg-done/15 text-done' },
  failed: {
    label: tr('故障'),
    dot: 'bg-danger',
    chip: 'bg-danger/15 text-danger',
  },
  waiting: {
    label: tr('等待'),
    dot: 'bg-attention',
    chip: 'bg-attention/15 text-attention',
  },
  idle: {
    label: tr('空闲'),
    dot: 'bg-muted-foreground/40',
    chip: 'bg-muted text-muted-foreground',
  },
  quota: {
    label: tr('额度用完'),
    dot: 'border border-attention bg-transparent',
    chip: 'border border-attention/60 text-attention',
  },
  offline: {
    label: tr('离线'),
    dot: 'border border-muted-foreground/50 bg-transparent',
    chip: 'border border-border text-muted-foreground',
  },
}

const ERROR_STOP_LABELS: Record<ModelErrorStop['reason'], string> = {
  quota: tr('额度用完'),
  rate_limit: tr('请求太频繁被限流'),
  overloaded: tr('模型服务过载'),
  auth: tr('登录失效'),
  api: tr('模型服务报错'),
}

/** 「额度用完 · 约 03:25 恢复」；拿不到恢复时间（或已经过了）只写「额度用完」 */
export function quotaText(resetsAt?: string, now = Date.now()): string {
  const at = resetsAt ? new Date(resetsAt) : null
  if (!at || at.getTime() <= now) {
    return tr('额度用完')
  }
  const hm = at.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return new Date(now).toDateString() === at.toDateString()
    ? tr('额度用完 · 约 {0} 恢复', [hm])
    : tr('额度用完 · 约 {0} {1} 恢复', [
        `${at.getMonth() + 1}/${at.getDate()}`,
        hm,
      ])
}

/** 出错停下的一句：额度用完写恢复时间；别的写「出错停了：模型服务过载」 */
export function errorStopText(stop: ModelErrorStop, resetsAt?: string) {
  return stop.reason === 'quota'
    ? quotaText(resetsAt)
    : tr('出错停了：{0}', [ERROR_STOP_LABELS[stop.reason]])
}

/** 主 Agent 之外还在跑的后台命令（后台 shell、Monitor）：只是一句说明，状态灯照旧按 status */
export const backgroundNote = (n?: number) =>
  n && n > 0 ? tr('后台 {0} 个命令在跑', [n]) : undefined

/** 终端标题：去掉 Agent 自己画在前面的转圈 / 星号；没有标题时为空 */
export const terminalTitle = (title?: string | null) =>
  title?.replace(/^[\u2800-\u28ff✳✻✽✶✢·*]+\s*/u, '').trim() || undefined

/** 终端里的 Agent 自己报的状态（引擎 agentStatus）：在等人点确认 */
const askingYou = new Set(['permission', 'waiting', 'blocked'])

/** 只看终端：在干活 / 等你确认 / 停着 */
export function terminalStatus(status?: string | null): AgentStatus {
  if (status === 'working') {
    return 'working'
  }
  if (status && askingYou.has(status)) {
    return 'waiting'
  }
  return 'idle'
}

/**
 * 实况优先：终端里的 Agent 在干活、在等你确认，就以终端为准——任务记录只在派活和汇报时更新，
 * 汇报完再接着让它干活，记录还停在「已完成」。终端停着时再看任务记录：
 * 做完了是完成，失败是故障；要你决定、等接单算等待（橙色只留给真要你管的）；记录说还在做而 Agent 停着，算空闲。
 *
 * terminal：节点的终端在列表里找到时传它的 status（停着可能是 undefined）；
 * 列表还没读到传 undefined；读到了但终端已经没了传 null。
 * session：坐在座位上的外部会话（Claude 桌面端等）没有终端，state 直接读自它的对话记录，
 * 说在干活就是在干活，不按「终端停着」算成等待。
 */
export function agentStatus({
  terminal,
  state,
  liveness,
  session,
  errorStop,
}: {
  terminal?: { status?: string } | null
  state?: NodeState
  liveness?: Liveness
  session?: boolean
  /** 模型服务报错停下了（派单记录里认的）：额度用完单算，别的算故障；终端在干活时以终端为准 */
  errorStop?: ModelErrorStop
}): AgentStatus | undefined {
  // 桌面端会话没有终端，本来就核实不了在线（unverifiable），照它对话记录里的状态显示
  if (session && !terminal) {
    if (state === 'working') {
      return 'working'
    }
    if (state === 'pending' || state === 'blocked') {
      return 'waiting'
    }
  }
  if (terminal) {
    const live = terminalStatus(terminal.status)
    if (live !== 'idle') {
      return live
    }
  }
  if (errorStop && terminal !== null && liveness !== 'exited') {
    return errorStop.reason === 'quota' ? 'quota' : 'failed'
  }
  // 座位登记的终端关了：离线，不是故障
  if (state === 'offline') {
    return 'offline'
  }
  const gone = terminal === null || liveness === 'exited'
  switch (state) {
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'working':
      // 终端没了活还没交：出故障了；终端停着、记录还没回填：只是空着，不算等你
      return gone ? 'failed' : 'idle'
    case 'pending':
    case 'blocked':
      return gone ? 'failed' : 'waiting'
    case 'exited':
      return 'idle'
    case 'idle':
      return 'idle'
  }
  if (terminal || liveness === 'live') {
    return 'idle'
  }
  return undefined
}

export const urgencyStyle: Record<Urgency, { dot: string; label: string }> = {
  high: { dot: 'bg-danger', label: tr('紧急') },
  normal: { dot: 'bg-attention', label: tr('待定') },
  low: { dot: 'bg-muted-foreground/50', label: tr('不急') },
}

export const timelineKindLabel: Record<TimelineKind, string> = {
  leader: 'Leader Agent',
  objective: tr('目标'),
  task: tr('任务'),
  worker: tr('下属'),
  decision: tr('决策'),
  instruction: tr('指令'),
  system: tr('系统'),
  record: tr('工作记录'),
}

const timeFmt = new Intl.DateTimeFormat(locale, {
  hour: '2-digit',
  minute: '2-digit',
})
const dayFmt = new Intl.DateTimeFormat(locale, {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** 图表时间轴标签：同一天只显示时分，跨天带日期。 */
export function axisLabel(iso: string, withDay: boolean) {
  return (withDay ? dayFmt : timeFmt).format(new Date(iso))
}

/** 能当 Leader Agent 的几家，按钮上写产品名 */
export const LEADERS: AgentKind[] = ['claude', 'codex', 'kimi']
export const LEADER_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'ChatGPT',
  kimi: 'Kimi',
}
