import type { ComponentProps } from 'react'
import type { TopologyNode } from '@shared/api'
import type { AgentStatus } from '@/lib/hiveward-format'
import { cn } from '@/lib/utils'

/**
 * 架构图上四种角色各一种外形，一眼分得清：
 * CEO 圆角正方形、Personal Agent 圆形、Leader 胶囊、下属圆角长方卡片。
 * 状态的颜色和 agentStatusStyle 一致：干活蓝光沿边框转圈、完成绿边不动、等待（含待复核）橙色闪烁、
 * 空闲灰边，空位虚线、下线变淡。动画在 styles/index.css。
 */
export type SeatRole = 'ceo' | 'pa' | 'leader' | 'worker'
export type SeatTone = 'working' | 'done' | 'waiting' | 'idle'

/** 节点状态对到座位的灯：交了活等复核算等待；故障的颜色在状态标签上，座位不亮 */
export function seatTone(
  status: AgentStatus | null | undefined,
  review?: TopologyNode['review']
): SeatTone {
  if (status === 'done') {
    return review === 'awaiting' ? 'waiting' : 'done'
  }
  return status === 'working' || status === 'waiting' ? status : 'idle'
}

const SHAPE: Record<SeatRole, string> = {
  ceo: 'size-12 justify-center rounded-xl border-2',
  pa: 'size-11 justify-center overflow-hidden rounded-full border-2',
  leader: 'h-8 gap-1.5 rounded-full border-2 ps-1.5 pe-3 whitespace-nowrap',
  worker: 'w-56 flex-col items-stretch rounded-xl border px-3 py-2 text-start',
}

const TONE: Record<SeatTone, string> = {
  working: 'seat-working',
  done: 'border-done',
  waiting: 'seat-waiting',
  idle: 'border-border',
}

export function SeatShape({
  role,
  tone = 'idle',
  vacant,
  dim,
  open,
  className,
  ...props
}: ComponentProps<'button'> & {
  role: SeatRole
  tone?: SeatTone
  vacant?: boolean
  dim?: boolean
  open?: boolean
}) {
  return (
    <button
      type='button'
      data-open={open}
      className={cn(
        'flex shrink-0 items-center bg-panel transition',
        SHAPE[role],
        role === 'worker' ? 'lift hover-box' : 'hover:scale-105',
        vacant
          ? 'border-dashed border-border bg-panel/60 text-muted-foreground shadow-none hover:bg-accent'
          : TONE[tone],
        role === 'worker' && tone === 'idle' && !vacant && 'border-border',
        // 下属卡片边框细，干活时加粗一点让转圈的光看得见（内边距少 1px，卡片不变大）
        role === 'worker' &&
          tone === 'working' &&
          !vacant &&
          'border-2 px-[11px] py-[7px]',
        dim && 'opacity-60',
        open && 'ring-2 ring-ring',
        className
      )}
      {...props}
    />
  )
}
