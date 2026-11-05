import type { TopologyNode } from '@shared/api'
import { agentStatus, agentStatusStyle, timeAgo } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { useMachines } from '@/lib/machine'
import { underAirborne } from './airborne-seat'

/** 派到别的电脑上执行的下属：在哪台电脑、执行端的派单 id、那台电脑在不在线；不是远程下属返回 undefined */
export type RemoteExecution = {
  machineId: string
  dispatchId: string
  machineName: string
  online: boolean
}

/** 远程下属卡点开要找执行端那台电脑上的节点：同一个派单 id、不是它自己又合成出来的远程节点 */
export const executionNode = (nodes: TopologyNode[], dispatchId: string) =>
  nodes.find((n) => n.dispatchId === dispatchId && !n.execution)

/**
 * 架构图、左栏、中间栏共用：远程下属在哪台电脑上跑（machineName 没带时用机器列表查名字），
 * 在不在线以后台给的 online 为准，没给时看机器列表里那台的状态。
 */
export function useRemoteSeat() {
  const { data: machines } = useMachines()
  const nameOf = (id: string) =>
    machines?.find((m) => m.id === id)?.name ?? tr('另一台电脑')
  return {
    /** 我这边派出去、在别的电脑上跑的 */
    execution(n: TopologyNode): RemoteExecution | undefined {
      const x = n.execution
      if (!x) {
        return undefined
      }
      const machine = machines?.find((m) => m.id === x.machineId)
      return {
        ...x,
        machineName: n.machineName || nameOf(x.machineId),
        online: n.online ?? machine?.status === 'online',
      }
    },
    /** 别的电脑派到我这边来的：「来自 <电脑名>」；挂在空降 Leader 影子卡下面的不标 */
    from(n: TopologyNode): string | undefined {
      return n.dispatcherMachineId && !underAirborne(n)
        ? tr('来自 {0}', [nameOf(n.dispatcherMachineId)])
        : undefined
    },
  }
}

/** 远程下属卡上的小标记：「<电脑名> · 远程执行」 */
export const remoteLabel = (x: RemoteExecution) =>
  tr('{0} · 远程执行', [x.machineName])

/** 执行端那台电脑连不上时，写它最后报上来的状态：「<电脑名> 离线 · 最后状态 干活 · 3 分钟前」 */
export function offlineNote(x: RemoteExecution, n: TopologyNode): string {
  // 离线时后台把 liveness 报成 unverifiable（连不上，不是 Agent 坏了）：只看最后报上来的 state
  const s = agentStatus({ state: n.state, session: true })
  const last = [
    s && agentStatusStyle[s].label,
    n.lastSeenAt && timeAgo(n.lastSeenAt),
  ]
    .filter(Boolean)
    .join(' · ')
  return tr('{0} 离线 · 最后状态 {1}', [x.machineName, last || tr('未知')])
}
