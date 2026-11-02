import type { Task, TaskStatus } from '@shared/api'
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

/** 交了活、等上级复核的派单 */
export const awaitingReview = (t: Task) =>
  t.status === 'completed' && t.review?.state === 'awaiting'

/** 四组：要你处理的 → 等复核的 → 在做的 → 做完的 */
export const taskGroups: {
  key: 'attention' | 'review' | 'active' | 'done'
  label: string
  match: (t: Task) => boolean
}[] = [
  {
    key: 'attention',
    label: '受阻',
    match: (t) => t.status === 'blocked' || t.status === 'failed',
  },
  { key: 'review', label: '待复核', match: awaitingReview },
  {
    key: 'active',
    label: '进行中',
    match: (t) =>
      t.status === 'dispatched' ||
      t.status === 'ready' ||
      t.status === 'pending',
  },
  {
    key: 'done',
    label: '已完成',
    match: (t) => t.status === 'completed' && !awaitingReview(t),
  },
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

export const countTab = (tab: TaskTab, tasks: Task[]) =>
  tab === 'all'
    ? tasks.length
    : tasks.filter(taskGroups.find((g) => g.key === tab)!.match).length
