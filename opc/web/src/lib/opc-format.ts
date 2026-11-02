import type { Liveness, NodeState, TimelineKind, Urgency } from '@shared/api'

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) {
    return '刚刚'
  }
  const m = Math.round(s / 60)
  if (m < 60) {
    return `${m} 分钟前`
  }
  const h = Math.round(m / 60)
  if (h < 24) {
    return `${h} 小时前`
  }
  return `${Math.round(h / 24)} 天前`
}

export const livenessStyle: Record<Liveness, { dot: string; label: string }> = {
  live: { dot: 'bg-live', label: '在线' },
  unverifiable: { dot: 'bg-attention', label: '无法确认' },
  exited: { dot: 'bg-muted-foreground/50', label: '已退出' },
}

/**
 * Agent 的五种状态，全界面同一套颜色：干活蓝、完成绿、故障红、等待橙黄、空闲灰。
 * 架构图节点、控制台标题、终端标签、侧栏圆点都用它。
 */
export type AgentStatus = 'working' | 'done' | 'failed' | 'waiting' | 'idle'

export const agentStatusStyle: Record<
  AgentStatus,
  { label: string; dot: string; chip: string; pulse?: boolean }
> = {
  working: {
    label: '干活',
    dot: 'bg-working',
    chip: 'bg-working/15 text-working',
    pulse: true,
  },
  done: { label: '完成', dot: 'bg-done', chip: 'bg-done/15 text-done' },
  failed: { label: '故障', dot: 'bg-danger', chip: 'bg-danger/15 text-danger' },
  waiting: {
    label: '等待',
    dot: 'bg-attention',
    chip: 'bg-attention/15 text-attention',
  },
  idle: {
    label: '空闲',
    dot: 'bg-muted-foreground/40',
    chip: 'bg-muted text-muted-foreground',
  },
}

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
 * 做完了是完成，失败是故障；记录说还在做、要你决定、等接单，而 Agent 停着等输入，算等待。
 *
 * terminal：节点的终端在列表里找到时传它的 status（停着可能是 undefined）；
 * 列表还没读到传 undefined；读到了但终端已经没了传 null。
 */
export function agentStatus({
  terminal,
  state,
  liveness,
}: {
  terminal?: { status?: string } | null
  state?: NodeState
  liveness?: Liveness
}): AgentStatus | undefined {
  if (terminal) {
    const live = terminalStatus(terminal.status)
    if (live !== 'idle') {
      return live
    }
  }
  const gone = terminal === null || liveness === 'exited'
  if (liveness === 'unverifiable') {
    return 'failed'
  }
  switch (state) {
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'working':
    case 'pending':
    case 'blocked':
      // 终端没了活还没交：出故障了
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
  high: { dot: 'bg-danger', label: '紧急' },
  normal: { dot: 'bg-attention', label: '待定' },
  low: { dot: 'bg-muted-foreground/50', label: '不急' },
}

export const timelineKindLabel: Record<TimelineKind, string> = {
  leader: '负责人',
  objective: '目标',
  task: '任务',
  worker: '下属',
  decision: '决策',
  instruction: '指令',
  system: '系统',
}

const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
})
const dayFmt = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** 图表时间轴标签：同一天只显示时分，跨天带日期。 */
export function axisLabel(iso: string, withDay: boolean) {
  return (withDay ? dayFmt : timeFmt).format(new Date(iso))
}
