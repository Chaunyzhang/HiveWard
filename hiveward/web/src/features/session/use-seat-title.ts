import { useQuery } from '@tanstack/react-query'
import type { TopologyNode } from '@shared/api'
import { topologyQuery } from '@/lib/hiveward-api'
import { useMachineId } from '@/lib/machine'
import { seatTitle } from './session-tree'

/**
 * 会话坐的位子（seatTitle），读这台电脑的全公司架构图（和左栏同一份缓存）。
 * ofTerminal 按终端 handle 找节点；架构图上没有、或没坐座位的返回 undefined，调用方照旧显示终端标题。
 */
export function useSeatTitle() {
  const { data } = useQuery(topologyQuery(useMachineId()))
  const nodes = data?.nodes ?? []
  return {
    ofNode: (n: TopologyNode) => seatTitle(n, nodes),
    ofTerminal: (handle: string) => {
      // 外援那个节点是它被借去的地方，先认它自己的座位
      const n =
        nodes.find((x) => x.terminal === handle && !x.external) ??
        nodes.find((x) => x.terminal === handle)
      return n && seatTitle(n, nodes)
    },
  }
}
