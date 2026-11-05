import type { Task } from '@shared/api'
import { Check, Pause, X } from 'lucide-react'
import type { AgentStatus } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * 任务页的状态筛选：全部就是时间线；其余按任务现在的状态筛。
 * 待办分两种：待决策（Agent 问你的、停下来等你的、该你复核的）和待复核（派活的 Agent 自己会复核，你看着就行）。
 */
export type TaskFilter =
  | 'all'
  | 'active'
  | 'mine'
  | 'review'
  | 'done'
  | 'failed'

export const TASK_FILTERS: { value: TaskFilter; label: string }[] = [
  { value: 'all', label: tr('全部') },
  { value: 'active', label: tr('进行中') },
  { value: 'mine', label: tr('待决策') },
  { value: 'review', label: tr('待复核') },
  { value: 'done', label: tr('已完成') },
  { value: 'failed', label: tr('失败') },
]

/** 交了活、等上级复核的派单 */
export const awaitingReview = (t: Task) =>
  t.status === 'completed' && t.review?.state === 'awaiting'

/** 任务落在哪个筛选里（「全部」不用算） */
export function taskFilterOf(t: Task): Exclude<TaskFilter, 'all'> {
  if (awaitingReview(t)) {
    return t.review?.reviewer === 'owner' ? 'mine' : 'review'
  }
  if (t.status === 'blocked') {
    return 'mine'
  }
  if (t.status === 'completed') {
    return 'done'
  }
  if (t.status === 'failed') {
    return 'failed'
  }
  return 'active'
}

/**
 * 任务状态对到架构图的那套颜色：执行中 = 干活（蓝）、完成 = 完成（绿）、失败 = 故障（红）、
 * 受阻 / 等你复核 = 等待（橙）、排队 / 可开始 = 空闲（灰）。
 */
function taskLook(t: Task): { status: AgentStatus; label: string } {
  if (awaitingReview(t)) {
    return { status: 'waiting', label: tr('完成·待复核') }
  }
  // 模型服务报错停下：没做完也没失败，额度用完单独一种
  if (t.errorStop && t.status === 'dispatched') {
    return t.errorStop.reason === 'quota'
      ? { status: 'quota', label: tr('额度用完') }
      : { status: 'failed', label: tr('出错停了') }
  }
  switch (t.status) {
    case 'dispatched':
      return { status: 'working', label: tr('执行中') }
    case 'completed':
      return { status: 'done', label: tr('完成') }
    case 'failed':
      return { status: 'failed', label: tr('失败') }
    case 'blocked':
      return { status: 'waiting', label: tr('受阻') }
    case 'ready':
      return { status: 'idle', label: tr('可开始') }
    case 'pending':
      return { status: 'idle', label: tr('排队') }
  }
}

/**
 * 任务前面的状态图标（16px 圆）：
 * 干活 = 蓝圈里一个呼吸的点；完成 = 绿底白勾；故障 = 红底白叉；
 * 等待 = 橙底暂停（等你复核时是橙圈里一个勾：活交了，等你看）；空闲 = 灰色虚线圈。
 */
export function TaskGlyph({
  task,
  className,
}: {
  task: Task
  className?: string
}) {
  const { status, label } = taskLook(task)
  const review = awaitingReview(task)
  const base = cn(
    'grid size-4 shrink-0 place-items-center rounded-full [&_svg]:size-2.5 [&_svg]:stroke-[3]',
    className
  )
  return (
    <span
      title={label}
      aria-label={label}
      role='img'
      className={cn(
        base,
        styles[status],
        review &&
          'border-[1.5px] border-attention bg-transparent text-attention'
      )}
    >
      {status === 'working' && (
        <span className='size-1.5 animate-pulse rounded-full bg-working' />
      )}
      {status === 'done' && <Check />}
      {status === 'failed' && <X />}
      {status === 'quota' && <Pause />}
      {status === 'waiting' && (review ? <Check /> : <Pause />)}
    </span>
  )
}

const styles: Record<AgentStatus, string> = {
  working: 'border-[1.5px] border-working',
  done: 'bg-done text-background',
  failed: 'bg-danger text-background',
  waiting: 'bg-attention text-background',
  idle: 'border-[1.5px] border-dashed border-muted-foreground/60',
  quota: 'border-[1.5px] border-attention text-attention',
  offline: 'border-[1.5px] border-dotted border-muted-foreground/50',
}

/** 任务状态的一个词（执行中 / 完成·待复核 / 完成 / 失败 / 受阻 …） */
export const taskLabel = (t: Task) => taskLook(t).label
