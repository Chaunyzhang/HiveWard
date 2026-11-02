import { useOverview } from '@/lib/opc-api'
import { timeAgo } from '@/lib/opc-format'
import { useNow } from '@/hooks/use-now'

// 采集超过这个时长没更新，就认为同步中断。
const STALE_MS = 15_000

/** 执行层状态：引擎是否可达、采集是否新鲜。 */
export function useOrcaStatus() {
  const now = useNow()
  const { data, isError } = useOverview()
  const health = data?.health
  const stale =
    !!health && now - new Date(health.collectedAt).getTime() > STALE_MS
  if (isError) return { tone: 'error', label: '后台不可达', health } as const
  if (!health) return { tone: 'idle', label: '连接中', health } as const
  if (!health.reachable) {
    return { tone: 'error', label: '引擎离线', health } as const
  }
  if (stale)
    return {
      tone: 'warn',
      label: `同步中断 · ${timeAgo(health.collectedAt, now)}`,
      health,
    } as const
  return { tone: 'ok', label: '正常', health } as const
}
