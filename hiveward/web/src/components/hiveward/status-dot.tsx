import { agentStatusStyle, type AgentStatus } from '@/lib/hiveward-format'
import { cn } from '@/lib/utils'

/** Agent 状态小圆点：干活蓝（闪）、完成绿、故障红、等待橙黄、空闲灰；悬停看字 */
export function StatusDot({
  status,
  className,
}: {
  status: AgentStatus
  className?: string
}) {
  const s = agentStatusStyle[status]
  return (
    <span
      title={s.label}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        s.dot,
        s.pulse && 'animate-pulse',
        className
      )}
    />
  )
}
