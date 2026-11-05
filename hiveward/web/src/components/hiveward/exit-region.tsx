import type { AgentExitRegion } from '@shared/api'
import { Globe } from 'lucide-react'
import { countryName } from '@/lib/exit-region'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const RESTRICTED = [
  { agent: 'claude', label: 'Claude Code' },
  { agent: 'codex', label: 'ChatGPT' },
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
        {tr('出口地区：还没检测')}
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
      {tr('出口{0}', [countryName(region.country)])}
      <span className='text-muted-foreground'>·</span>
      {blocked.length
        ? tr('{0} 不能在这台开', [blocked.map((a) => a.label).join('、')])
        : tr('Claude Code、ChatGPT 可以开')}
    </p>
  )
}
