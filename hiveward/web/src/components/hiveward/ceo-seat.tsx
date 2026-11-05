import type { TopologyNode } from '@shared/api'
import { Plus } from 'lucide-react'
import {
  agentStatus,
  agentStatusStyle,
  backgroundNote,
} from '@/lib/hiveward-format'
import { useHiveWardTerminals } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { useSettledStatus } from '@/hooks/use-settled-status'
import { AgentLogo } from './agent-logo'
import { SeatShape, seatTone } from './seat-shape'

/**
 * 这块业务的 CEO 位：圆角正方形，坐在业务到项目的直线上（线接方块，名字写在下面），Personal Agent 在它正上方。座位常驻、人不常驻——
 * 空着时是虚线框，点开选一家 Agent 坐上去；坐着时画那家的 logo，灯和别的座位一样（干活蓝光转圈、完成绿、等待橙闪）。
 */
export function CeoSeat({
  ceo,
  open,
  onOpen,
}: {
  ceo: TopologyNode
  open: boolean
  onOpen?: (node: TopologyNode) => void
}) {
  const { data } = useHiveWardTerminals()
  const terminal =
    ceo.terminal && data
      ? (data.find((t) => t.handle === ceo.terminal) ?? null)
      : undefined
  const status = useSettledStatus(
    agentStatus({
      terminal,
      state: ceo.state,
      liveness: ceo.liveness,
      session: !!ceo.sessionId,
    })
  )
  const seated =
    !!ceo.agent &&
    (!!ceo.sessionId || !!ceo.terminal) &&
    ceo.liveness !== 'exited'
  const note = !seated
    ? tr('空位')
    : status
      ? agentStatusStyle[status].label
      : ceo.sessionId
        ? tr('桌面端会话')
        : undefined
  const background = seated
    ? backgroundNote(terminal?.backgroundCommands)
    : undefined
  return (
    <div className='flex flex-col items-center gap-1.5'>
      <SeatShape
        data-port
        role='ceo'
        tone={seated ? seatTone(status) : 'idle'}
        vacant={!seated}
        open={open}
        title={
          seated
            ? `CEO Agent · ${ceo.activity ?? ''}`
            : tr('CEO 位空着：点开选一家 Agent 坐上去')
        }
        onClick={() => onOpen?.(ceo)}
      >
        {seated ? (
          <AgentLogo agent={ceo.agent} className='size-6' />
        ) : (
          <Plus className='size-4' />
        )}
      </SeatShape>
      <span className='text-[10px] leading-3 whitespace-nowrap text-muted-foreground'>
        CEO Agent{note && <> · {note}</>}
      </span>
      {background && (
        <span className='-mt-1 text-[10px] leading-3 whitespace-nowrap text-muted-foreground'>
          {background}
        </span>
      )}
    </div>
  )
}
