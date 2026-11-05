import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { topologyQuery } from '@/lib/hiveward-api'
import { useMachineId } from '@/lib/machine'

/**
 * 打开某个终端的对话页（待决策里点任务、点 Agent 的提问时用）：
 * 架构图上有这个终端就用它的节点，没有就按终端现拼（hiveward:handle）。
 */
export function useOpenSession() {
  const navigate = useNavigate()
  const m = useMachineId()
  const { data } = useQuery(topologyQuery(m))
  return ({
    terminal,
    businessId,
  }: {
    terminal: string
    businessId?: string
  }) => {
    const node = data?.nodes.find((n) => n.terminal === terminal)
    const session = node?.id ?? `hiveward:${terminal}`
    const business = node?.businessId ?? businessId
    void (business
      ? navigate({
          to: '/b/$businessId',
          params: { businessId: business },
          search: { session },
        })
      : navigate({ to: '/', search: { session } }))
  }
}
