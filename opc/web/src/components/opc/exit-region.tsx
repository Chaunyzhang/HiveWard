import type { AgentExitRegion } from '@shared/api'
import { Globe } from 'lucide-react'
import { countryName } from '@/lib/exit-region'
import { cn } from '@/lib/utils'

const RESTRICTED = [
  { agent: 'claude', label: 'Claude Code' },
  { agent: 'codex', label: 'Codex' },
] as const

/** 局域网页电脑卡片里的一行：出口地区 + 受限 Agent 能不能开 */
export function ExitRegionLine({
  region,
  className,
}: {
  region: AgentExitRegion | null
  className?: string
}) {
  if (!region) {
    return (
      <p className={cn('text-[11px] text-muted-foreground', className)}>
        出口地区：还没检测
      </p>
    )
  }
  const blocked = RESTRICTED.filter(
    (a) => region.agents[a.agent]?.allowed === false
  )
  return (
    <p
      title={region.limitation}
      className={cn(
        'flex items-center gap-1.5 text-[11px]',
        blocked.length ? 'text-danger' : 'text-muted-foreground',
        className
      )}
    >
      <Globe className='size-3 shrink-0' />
      出口{countryName(region.country)}
      <span className='text-muted-foreground'>·</span>
      {blocked.length
        ? `${blocked.map((a) => a.label).join('、')} 不能在这台开`
        : 'Claude Code、Codex 可以开'}
    </p>
  )
}
