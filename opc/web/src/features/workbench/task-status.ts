import type { TaskStatus } from '@shared/api'
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDot,
  CircleX,
} from 'lucide-react'

export const statusIcon: Record<
  TaskStatus,
  { icon: React.ElementType; className: string; label: string }
> = {
  dispatched: { icon: CircleDot, className: 'text-brand', label: '执行中' },
  ready: { icon: Circle, className: 'text-foreground/60', label: '可开始' },
  pending: {
    icon: Circle,
    className: 'text-muted-foreground/60',
    label: '排队',
  },
  blocked: { icon: CircleAlert, className: 'text-attention', label: '受阻' },
  completed: {
    icon: CheckCircle2,
    className: 'text-muted-foreground',
    label: '完成',
  },
  failed: { icon: CircleX, className: 'text-danger', label: '失败' },
}

/** 三组：要你处理的 → 在做的 → 做完汇报的 */
export const taskGroups: {
  key: 'attention' | 'active' | 'done'
  label: string
  match: (s: TaskStatus) => boolean
}[] = [
  {
    key: 'attention',
    label: '受阻',
    match: (s) => s === 'blocked' || s === 'failed',
  },
  {
    key: 'active',
    label: '进行中',
    match: (s) => s === 'dispatched' || s === 'ready' || s === 'pending',
  },
  { key: 'done', label: '已汇报', match: (s) => s === 'completed' },
]

// 组内排序：执行中 → 可开始 → 排队
export const statusOrder: Record<TaskStatus, number> = {
  blocked: 0,
  failed: 1,
  dispatched: 0,
  ready: 1,
  pending: 2,
  completed: 0,
}

export type TaskTab = 'all' | (typeof taskGroups)[number]['key']

/** 任务面板的切换按钮：全部 + 每个状态组各一栏 */
export const taskTabs: { value: TaskTab; label: string }[] = [
  { value: 'all', label: '全部' },
  ...taskGroups.map((g) => ({ value: g.key, label: g.label })),
]

export const countTab = (tab: TaskTab, statuses: TaskStatus[]) =>
  tab === 'all'
    ? statuses.length
    : statuses.filter(taskGroups.find((g) => g.key === tab)!.match).length
