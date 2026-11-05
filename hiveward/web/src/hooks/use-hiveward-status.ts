import { useOverview } from '@/lib/hiveward-api'
import { timeAgo } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { useNow } from '@/hooks/use-now'

// 采集超过这个时长没更新，就认为同步中断。
const STALE_MS = 15_000

/** 执行层状态：引擎是否可达、采集是否新鲜。hint 是给人看的说明（设置页里显示） */
export function useHiveWardStatus() {
  const now = useNow()
  const { data, isError } = useOverview()
  const health = data?.health
  const stale =
    !!health && now - new Date(health.collectedAt).getTime() > STALE_MS
  if (isError) {
    return {
      tone: 'error',
      label: tr('后台不可达'),
      hint: tr('网页连不上 HiveWard 后台，看看 HiveWard 是否还开着。'),
      health,
    } as const
  }
  if (!health) {
    return {
      tone: 'idle',
      label: tr('连接中'),
      hint: tr('正在连接引擎…'),
      health,
    } as const
  }
  if (!health.reachable) {
    return {
      tone: 'error',
      label: tr('引擎离线'),
      hint: tr(
        '后台连不上执行引擎，终端和 Agent 暂时用不了；重开 HiveWard 一般能恢复。'
      ),
      health,
    } as const
  }
  if (stale) {
    return {
      tone: 'warn',
      label: tr('同步中断 · {0}', [timeAgo(health.collectedAt, now)]),
      hint: tr('引擎一阵子没回新数据了，界面上的状态可能不是最新的。'),
      health,
    } as const
  }
  return {
    tone: 'ok',
    label: tr('正常'),
    hint: tr('执行引擎在运行，状态实时同步。'),
    health,
  } as const
}
