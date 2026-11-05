import type { TopologyNode } from '@shared/api'
import { tr } from '@/lib/i18n'

/**
 * 空降 Leader：别的电脑（A）上的 CEO / Leader 往这台电脑（B）派了活，B 的图上替它画一张影子卡，
 * 派来的下属挂在影子卡下面。id `airborne:<A 的机器 id>:<派单方 id>`，kind 是 leader。
 */
export type Airborne = NonNullable<TopologyNode['airborne']> &
  Pick<TopologyNode, 'online' | 'count' | 'remoteChildren'>

/** 影子节点的空降信息，连同节点上的在线、派来几个；不是影子节点返回 undefined */
export const airborneOf = (n: TopologyNode): Airborne | undefined =>
  n.airborne && {
    ...n.airborne,
    online: n.online,
    count: n.count,
    remoteChildren: n.remoteChildren,
  }

/** 挂在影子卡下面的（parentId 是 `airborne:…`）：影子行已经写了从哪台电脑来，下属不再标「来自」 */
export const underAirborne = (n: TopologyNode) =>
  !!n.parentId?.startsWith('airborne:')

/** 多机总览里 A 列也在时只画占位：影子卡下面不再画 A 列已经画过的那些下属（remoteChildren） */
export function airborneKids<T extends { dispatchId?: string }>(
  a: Airborne,
  kids: T[],
  merged: boolean
): T[] {
  const skip = a.remoteChildren
  return merged && skip
    ? kids.filter((k) => !skip.includes(k.dispatchId ?? ''))
    : kids
}

/** 只有空降派单的未登记目录，后台根节点 label 固定写「外来派单」：换成当前语言 */
export const rootLabel = (n: TopologyNode) =>
  n.unregistered && n.label === '外来派单' ? tr('外来派单') : n.label

/** 影子卡上的名字：「Mac · Leader · 空降」 */
export const airborneLabel = (a: Airborne) =>
  tr('{0} · {1} · 空降', [a.machineName, a.dispatcherLabel])

/** 多机总览里的占位：「Mac Leader 派来 3 个」 */
export const airborneCount = (a: Airborne) =>
  tr('{0} {1} 派来 {2} 个', [
    a.machineName,
    a.dispatcherLabel,
    a.count ?? a.remoteChildren?.length ?? 0,
  ])

/** A 上真正派单的那个座位：CEO / Leader 节点按节点 id、会话、派单方、终端认（不认它自己合成的远程卡） */
export function dispatcherSeat(nodes: TopologyNode[], dispatcherId: string) {
  const own = nodes.filter((n) => !n.execution && !airborneOf(n))
  const hit = (n: TopologyNode) =>
    n.id === dispatcherId ||
    n.sessionId === dispatcherId ||
    n.dispatcher === dispatcherId ||
    n.terminal === dispatcherId
  return (
    own.find((n) => (n.kind === 'ceo' || n.kind === 'leader') && hit(n)) ??
    own.find(hit)
  )
}
