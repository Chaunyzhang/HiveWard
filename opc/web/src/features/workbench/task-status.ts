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
