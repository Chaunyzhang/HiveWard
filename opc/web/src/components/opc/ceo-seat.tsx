import type { TopologyNode } from '@shared/api'
import { Plus } from 'lucide-react'
import { agentStatus, agentStatusStyle } from '@/lib/opc-format'
import { useOrcaTerminals } from '@/lib/orca-live'
import { cn } from '@/lib/utils'
import { useSettledStatus } from '@/hooks/use-settled-status'
import { AgentLogo } from './agent-logo'

/**
 * 这块业务的 CEO 位：坐在业务到项目的直线上，Personal Agent 从上面绕过它。座位常驻、人不常驻——
 * 空着时是虚线圈，点开选一家 Agent 坐上去；坐着时画那家的 logo，干活时发光。
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
  const { data } = useOrcaTerminals()
  const terminal =
    ceo.terminal && data
      ? (data.find((t) => t.handle === ceo.terminal) ?? null)
      : undefined
  const status = useSettledStatus(
    agentStatus({ terminal, state: ceo.state, liveness: ceo.liveness })
  )
  const seated =
    !!ceo.agent &&
    (!!ceo.sessionId || !!ceo.terminal) &&
    ceo.liveness !== 'exited'
  const working = seated && status === 'working'
  const note = !seated
    ? '空位'
    : ceo.sessionId
      ? '桌面端会话'
      : status
        ? agentStatusStyle[status].label
        : undefined
  return (
    <>
      <span className='absolute start-1/2 top-[calc(50%+24px)] -translate-x-1/2 text-center text-[10px] leading-3 whitespace-nowrap text-muted-foreground'>
        CEO Agent{note && <> · {note}</>}
      </span>
      <button
        type='button'
        data-open={open}
        title={
          seated
            ? `CEO Agent · ${ceo.activity ?? ''}`
            : 'CEO 位空着：点开选一家 Agent 坐上去'
        }
        onClick={() => onOpen?.(ceo)}
        className={cn(
          'absolute start-1/2 top-1/2 flex size-10 -translate-1/2 items-center justify-center rounded-full border-2 bg-panel transition-shadow hover:scale-105',
          !seated && 'border-dashed text-muted-foreground',
          working
            ? 'border-brand shadow-[0_0_16px] shadow-brand/60'
            : 'border-border',
          open && 'ring-2 ring-ring'
        )}
      >
        {seated ? (
          <AgentLogo agent={ceo.agent} className='size-5' />
        ) : (
          <Plus className='size-4' />
        )}
      </button>
    </>
  )
}
