import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useWorkspace } from '@/stores/workspace'
import { overviewQuery, tasksQuery, topologyQuery } from '@/lib/hiveward-api'
import { terminalsQuery } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { MachineScope, useCurrentMachineId } from '@/lib/machine'
import { DockedContext, PaneHeader } from '@/components/layout/top-bar-slot'
import { BackButton } from '@/features/live/agent-console'
import { SessionToolbar } from '@/features/session/session-toolbar'
import { AgentPane } from './agent-pane'
import { hivewardWorker } from './hiveward-nodes'
import { RemoteSession } from './remote-session'

/** 地址栏里的会话：架构图节点 id + 在哪台电脑上（null 是正在看的那台） */
export type OpenSession = { id: string; machine: string | null }

/**
 * 中间栏打开一个会话（从左栏的会话树、或架构图上点卡片）：整个中间栏都给它的对话 / 终端，
 * 标题行右边是会话工具栏。打开的是哪个会话记在地址栏里，刷新、后退都能回来。
 */
export function SessionView({
  session,
  businessId,
}: {
  session: OpenSession
  /** 业务页里打开的：架构图只取这块业务 */
  businessId?: string
}) {
  const viewing = useCurrentMachineId()
  const m = session.machine ?? viewing
  const navigate = useNavigate()
  const setSession = useWorkspace((s) => s.setSession)
  const topology = useQuery(topologyQuery(m, businessId))
  // 换到别的业务里的会话时，这块业务的架构图可能还没读过：先用左栏手上的全公司架构图找节点，不闪「读取会话…」
  const everywhere = useQuery(topologyQuery(m))
  const tasks = useQuery(tasksQuery(m, businessId))
  const overview = useQuery(overviewQuery(m))
  const terminals = useQuery(terminalsQuery(m))

  // 首页上没经派单、不在任何业务里的终端，架构图里没有，按终端现拼一个
  const loose = session.id.startsWith('hiveward:')
    ? terminals.data?.find((t) => t.handle === session.id.slice(5))
    : undefined
  const node =
    topology.data?.nodes.find((n) => n.id === session.id) ??
    everywhere.data?.nodes.find((n) => n.id === session.id) ??
    (loose && hivewardWorker(loose, ''))
  const businesses = overview.data?.businesses ?? []
  const business = businesses.find((b) => b.id === node?.businessId)
  const project = business?.projects?.find((p) => p.id === node?.projectId)
  const terminal = terminals.data?.find((t) => t.handle === node?.terminal)
  const dir =
    terminal?.project ??
    node?.project ??
    project?.path ??
    business?.workspacePath
  const handle = node?.terminal
  // 派到别的电脑上执行的下属：RemoteSession 自己记中间栏打开的是谁（执行端那台电脑上的节点）
  const remote = !!node?.execution

  useEffect(() => {
    if (remote) {
      return
    }
    setSession({
      nodeId: session.id,
      machine: m,
      scope: businessId,
      handle,
      dir,
    })
    return () => setSession(null)
  }, [session.id, m, businessId, handle, dir, remote, setSession])

  const close = () =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        session: undefined,
        m: undefined,
      }),
    })

  if (!node) {
    const loading = topology.isLoading || terminals.isLoading
    return (
      <DockedContext.Provider value>
        <div className='flex h-full flex-col'>
          <PaneHeader className='gap-2.5'>
            <BackButton onClick={close} />
            <h2 className='min-w-0 flex-1 truncate text-[13px] font-medium'>
              {loading ? tr('读取会话…') : tr('会话不在了')}
            </h2>
            <SessionToolbar />
          </PaneHeader>
          {!loading && (
            <p className='p-6 text-[13px] text-muted-foreground'>
              {topology.error
                ? tr('读取失败：{0}', [topology.error.message])
                : tr('这个会话已经结束，或者已经不在架构图上了。')}
            </p>
          )}
        </div>
      </DockedContext.Provider>
    )
  }

  if (remote) {
    return (
      <DockedContext.Provider value>
        <RemoteSession key={node.id} node={node} machine={m} onClose={close} />
      </DockedContext.Provider>
    )
  }

  return (
    <DockedContext.Provider value>
      <MachineScope id={m}>
        <AgentPane
          node={node}
          tasks={tasks.data ?? []}
          businesses={businesses}
          // 业务页链接只对正在看的那台电脑有效
          showBusinessLink={!businessId && m === viewing}
          onClose={close}
          tools={<SessionToolbar className='ms-auto' />}
        />
      </MachineScope>
    </DockedContext.Provider>
  )
}
