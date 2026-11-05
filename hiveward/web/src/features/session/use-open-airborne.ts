import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { topologyQuery } from '@/lib/hiveward-api'
import { tr } from '@/lib/i18n'
import { useMachines, useSwitchMachine } from '@/lib/machine'
import { dispatcherSeat, type Airborne } from './airborne-seat'

/** 影子卡在不在线：以后台给的 online 为准，没给时看机器列表里 A 的状态 */
export function useAirborneOnline() {
  const { data: machines } = useMachines()
  return (a: Airborne) =>
    a.online ?? machines?.find((m) => m.id === a.machineId)?.status === 'online'
}

/**
 * 点影子卡：到 A 上找真正派单的那个座位，打开它的会话（地址栏带 m=A，请求走 /api/m/<A>/…）。
 * A 就是本机、而正在看的是别的电脑时，先切回本机再开。
 */
export function useOpenAirborne() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const switchTo = useSwitchMachine()
  const { data: machines } = useMachines()
  return async (a: Airborne) => {
    const self = machines?.find((m) => m.self)
    const local = self?.id === a.machineId
    const m = local ? null : a.machineId
    try {
      const { nodes } = await qc.fetchQuery(topologyQuery(m))
      const seat = dispatcherSeat(nodes, a.dispatcherId)
      if (!seat) {
        toast.error(tr('{0} 上找不到这个派单方了', [a.machineName]))
        return
      }
      if (local && self) {
        await switchTo(self)
      }
      void navigate({
        to: '/',
        search: { session: seat.id, m: m ?? undefined },
      })
    } catch (e) {
      toast.error(
        tr('连不上 {0}：{1}', [
          a.machineName,
          e instanceof Error ? e.message : String(e),
        ])
      )
    }
  }
}
