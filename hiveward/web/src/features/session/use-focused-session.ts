import { useQuery } from '@tanstack/react-query'
import type { Task } from '@shared/api'
import { useWorkspace } from '@/stores/workspace'
import { tasksQuery, topologyQuery } from '@/lib/hiveward-api'
import { terminalsQuery } from '@/lib/hiveward-live'
import { taskFilterOf } from '@/features/workbench/task-status'

/**
 * 中间栏打开的会话，和它派出去、还在跑的活。工具栏和右栏都用它；
 * 读的是和中间栏同一份缓存（同一台电脑、同一个架构图范围）。
 */
export function useFocusedSession() {
  const session = useWorkspace((s) => s.session)
  const m = session?.machine ?? null
  const enabled = { enabled: !!session }
  const topology = useQuery({
    ...topologyQuery(m, session?.scope),
    ...enabled,
  })
  const tasks = useQuery({ ...tasksQuery(m, session?.scope), ...enabled })
  const terminals = useQuery({ ...terminalsQuery(m), ...enabled })
  if (!session) {
    return null
  }
  const node = topology.data?.nodes.find((n) => n.id === session.nodeId)
  const by = node?.sessionId ?? node?.dispatcher
  const running: Task[] = by
    ? (tasks.data ?? []).filter(
        (t) => t.dispatchedBy?.id === by && taskFilterOf(t) === 'active'
      )
    : []
  return {
    ...session,
    running,
    terminals: terminals.data,
  }
}
