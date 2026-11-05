import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TopologyNode } from '@shared/api'
import { useWorkspace } from '@/stores/workspace'
import { overviewQuery, tasksQuery, topologyQuery } from '@/lib/hiveward-api'
import { duration, timeAgo } from '@/lib/hiveward-format'
import { terminalsQuery } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { MachineScope } from '@/lib/machine'
import { SeatTag } from '@/components/hiveward/external-tag'
import { BackButton, ConsoleView } from '@/features/live/agent-console'
import {
  executionNode,
  offlineNote,
  remoteLabel,
  useRemoteSeat,
} from '@/features/session/remote-seat'
import { SessionToolbar } from '@/features/session/session-toolbar'
import { seatTitle } from '@/features/session/session-tree'
import { AgentPane } from './agent-pane'

/**
 * 点开派到别的电脑上执行的下属：对话、终端、输入、停止、复核都在执行端那台电脑上，
 * 整块包进那台电脑的 MachineScope（请求走 /api/m/<电脑>/…，handle / 派单 id 用执行端的），不在本机找同名终端。
 * 那台电脑离线、或那边已经没有这个派单时，只读显示本机记下的最后状态。
 */
export function RemoteSession({
  node,
  machine,
  onClose,
}: {
  /** 本机架构图上的远程下属节点 */
  node: TopologyNode
  /** 本机架构图是哪台电脑的；null 为本机 */
  machine: string | null
  onClose: () => void
}) {
  const x = useRemoteSeat().execution(node)!
  const m = x.machineId
  // 标题照本机这边的座位写（「网店 · CEO · 下属」），不写执行端那边的座位名
  const local = useQuery(topologyQuery(machine))
  const title = seatTitle(node, local.data?.nodes ?? []) ?? node.label
  const on = { enabled: x.online }
  const topology = useQuery({ ...topologyQuery(m), ...on })
  const tasks = useQuery({ ...tasksQuery(m), ...on })
  const overview = useQuery({ ...overviewQuery(m), ...on })
  const terminals = useQuery({ ...terminalsQuery(m), ...on })
  const target =
    x.online && topology.data
      ? executionNode(topology.data.nodes, x.dispatchId)
      : undefined
  const dir =
    terminals.data?.find((t) => t.handle === target?.terminal)?.project ??
    target?.project
  const setSession = useWorkspace((s) => s.setSession)
  const targetId = target?.id
  const handle = target?.terminal
  useEffect(() => {
    const via = { nodeId: node.id, machine }
    setSession(
      targetId
        ? { nodeId: targetId, machine: m, handle, dir, via }
        : { nodeId: node.id, machine, via }
    )
    return () => setSession(null)
  }, [node.id, machine, m, targetId, handle, dir, setSession])

  const tag = (
    <SeatTag className='shrink' title={tr('对话和操作都发到那台电脑')}>
      {remoteLabel(x)}
    </SeatTag>
  )
  if (target) {
    return (
      <MachineScope id={m}>
        <AgentPane
          node={target}
          tasks={tasks.data ?? []}
          businesses={overview.data?.businesses ?? []}
          // 业务页链接只对正在看的那台电脑有效
          showBusinessLink={false}
          onClose={onClose}
          title={title}
          tools={
            <>
              {tag}
              <SessionToolbar className='ms-auto' />
            </>
          }
        />
      </MachineScope>
    )
  }
  const connecting = x.online && topology.isPending
  return (
    <LastState
      node={node}
      title={title}
      onClose={onClose}
      tag={tag}
      status={
        !x.online
          ? offlineNote(x, node)
          : connecting
            ? tr('连接 {0}…', [x.machineName])
            : topology.isError
              ? tr('连不上 {0}：{1}', [x.machineName, topology.error.message])
              : tr('{0} 上已经没有这个派单了', [x.machineName])
      }
      readOnly={
        connecting
          ? tr('正在连接执行这个活的电脑…')
          : tr('{0} 连不上，只能看最后状态；连上后才能对话、停止、复核', [
              x.machineName,
            ])
      }
    />
  )
}

/** 执行端连不上：只读显示本机架构图上记下的最后状态，输入框换成说明（停止、复核都不可用） */
function LastState({
  node: n,
  title,
  onClose,
  tag,
  status,
  readOnly,
}: {
  node: TopologyNode
  title: string
  onClose: () => void
  tag: React.ReactNode
  status: string
  readOnly: string
}) {
  const lines = [
    n.activity && tr('手上：{0}', [n.activity]),
    n.review === 'awaiting' && tr('交了活，等复核'),
    n.startedAt &&
      (n.finishedAt
        ? tr('用时 {0}', [duration(n.startedAt, n.finishedAt)])
        : tr('开始于 {0}', [timeAgo(n.startedAt)])),
    n.lastSeenAt && tr('最后消息 {0}', [timeAgo(n.lastSeenAt)]),
  ].filter(Boolean)
  return (
    <ConsoleView
      leading={<BackButton onClick={onClose} />}
      agent={n.agent}
      title={title}
      tone='idle'
      status={status}
      chat={null}
      screen={lines.join('\n') || tr('没有记下更多状态')}
      working={false}
      placeholder=''
      readOnly={readOnly}
      trailing={
        <>
          {tag}
          <SessionToolbar className='ms-auto' offline={readOnly} />
        </>
      }
      className='h-full'
    />
  )
}
