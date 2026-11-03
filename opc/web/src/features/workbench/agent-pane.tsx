import { Link } from '@tanstack/react-router'
import type { BusinessSummary, Project, Task, TopologyNode } from '@shared/api'
import { toast } from 'sonner'
import { useLaunchProjectLeader, useWorkerScreen } from '@/lib/opc-api'
import {
  agentStatus,
  agentStatusStyle,
  LEADER_LABEL,
  LEADERS,
  timeAgo,
} from '@/lib/opc-format'
import { useOrcaTerminals } from '@/lib/orca-live'
import { AgentLogo } from '@/components/opc/agent-logo'
import { ProjectLogo } from '@/components/opc/project-logo'
import { AgentConsole, ConsoleView } from '@/features/live/agent-console'
import { TaskList } from './dispatched-tasks'
import { GrokProfile } from './grok-profile'
import { NoCeo } from './no-ceo'

/**
 * 点架构图节点，在中间栏打开：这个 Agent 的实时输出（对话 / 终端），和「现场」同一个控制台；
 * 它开的网页在右栏浏览器里。接了终端的直接连真终端；其余的读负责人 / 下属的终端画面。
 */
export function AgentPane({
  node,
  tasks,
  businesses,
  showBusinessLink,
  onClose,
}: {
  node: TopologyNode
  tasks: Task[]
  businesses: BusinessSummary[]
  showBusinessLink: boolean
  onClose: () => void
}) {
  const business = businesses.find((b) => b.id === node.businessId)
  const task =
    node.kind === 'worker' ? tasks.find((t) => t.id === node.taskId) : undefined
  return (
    <div className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl panel'>
      {node.kind === 'grok' ? (
        <GrokProfile
          tasks={tasks.filter(
            (t) =>
              t.dispatchedBy?.kind === 'grok' &&
              t.businessId === node.businessId
          )}
        />
      ) : node.dispatcher || node.sessionId ? (
        <Dispatcher
          node={node}
          tasks={tasks.filter(
            (t) => t.dispatchedBy?.id === (node.sessionId ?? node.dispatcher)
          )}
        />
      ) : node.terminal ? (
        <LiveAgent key={node.id} node={node} />
      ) : node.kind === 'ceo' ? (
        <NoCeo business={business} exited={node.liveness === 'exited'} />
      ) : node.kind === 'leader' ? (
        <NoLeader
          project={business?.projects?.find((p) => p.id === node.projectId)}
          exited={node.liveness === 'exited'}
        />
      ) : (
        <ScreenAgent
          key={node.id}
          node={node}
          context={
            <Context
              node={node}
              business={business}
              task={task}
              link={showBusinessLink}
              onClose={onClose}
            />
          }
        />
      )}
    </div>
  )
}

/** 接了 Orca 终端的节点：真终端，能看能说 */
function LiveAgent({ node }: { node: TopologyNode }) {
  const terminals = useOrcaTerminals()
  const terminal = terminals.data?.find((t) => t.handle === node.terminal)
  return terminal ? (
    <AgentConsole terminal={terminal} className='h-full' />
  ) : (
    <p className='p-6 text-[13px] text-muted-foreground'>
      {terminals.isLoading ? '连接引擎…' : '这个终端已经关掉了。'}
    </p>
  )
}

/** 没有直连终端的节点：读负责人 / 下属的终端画面和对话记录 */
function ScreenAgent({
  node: n,
  context,
}: {
  node: TopologyNode
  context: React.ReactNode
}) {
  const screen = useWorkerScreen(n.dispatchId ?? null)
  const stale = n.liveness === 'unverifiable'
  const status = agentStatus({ state: n.state, liveness: n.liveness }) ?? 'idle'
  return (
    <ConsoleView
      agent={n.agent}
      title={n.label}
      subtitle={n.sublabel}
      tone={status}
      status={
        stale
          ? `故障 · 失联，心跳 ${n.lastSeenAt ? timeAgo(n.lastSeenAt) : '未知'}`
          : agentStatusStyle[status].label
      }
      context={context}
      chat={screen.data?.items ?? null}
      screen={
        screen.isError
          ? `读不到终端：${screen.error.message}`
          : (screen.data?.text ?? '读取画面…')
      }
      working={status === 'working'}
      placeholder='这个 Agent 没有直连的终端，只能看，不能直接说话'
      className='h-full'
    />
  )
}

/** 派单方（开在项目目录里的 Claude Code 会话）：对话在它自己那边，这里只列它派出去的活和结果 */
function Dispatcher({ node: n, tasks }: { node: TopologyNode; tasks: Task[] }) {
  return (
    <div className='flex h-full flex-col'>
      <header className='flex h-12 shrink-0 items-center gap-3 px-4'>
        <AgentLogo agent={n.agent} className='size-4' />
        <h2 className='text-[13px] font-medium'>{n.label}</h2>
        {n.sublabel && (
          <span className='text-xs text-muted-foreground'>{n.sublabel}</span>
        )}
        <span className='text-xs text-muted-foreground'>
          {n.sessionId
            ? '坐在这个位置上的是一个桌面端会话：要跟它说话回 Claude 桌面端，这里看它派出去的活'
            : `对话在${n.sublabel ?? n.label}进行，这里看它派出去的活`}
        </span>
      </header>
      <div className='min-h-0 flex-1 overflow-y-auto px-3 pb-6'>
        <TaskList tasks={tasks} />
      </div>
    </div>
  )
}

/** 项目还没开 Leader Agent（或 Leader Agent 退出了）：选一家开一个；「未归项目」没有 Leader Agent 可开 */
function NoLeader({ project, exited }: { project?: Project; exited: boolean }) {
  const launch = useLaunchProjectLeader()
  if (!project) {
    return (
      <p className='p-6 text-[13px] text-muted-foreground'>
        这些 Agent 开在业务目录里，但不属于任何项目。
      </p>
    )
  }
  return (
    <div className='flex h-full flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground'>
      <p>
        「{project.name}」
        {exited ? '的 Leader Agent 已经退出了。' : '还没开 Leader Agent。'}
      </p>
      <div className='flex gap-2'>
        {LEADERS.map((a) => (
          <button
            key={a}
            type='button'
            disabled={launch.isPending}
            onClick={() =>
              launch.mutate(
                { project, agent: a, replace: exited },
                {
                  onSuccess: () =>
                    toast.success('Leader Agent 已开，稍等它出现在架构图里'),
                  onError: (e) => toast.error(`没开成：${e.message}`),
                }
              )
            }
            className='flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs text-foreground hover:bg-accent disabled:opacity-40'
          >
            <AgentLogo agent={a} className='size-3.5' />
            {LEADER_LABEL[a]}
          </button>
        ))}
      </div>
    </div>
  )
}

function Context({
  node: n,
  business: b,
  task,
  link,
  onClose,
}: {
  node: TopologyNode
  business?: BusinessSummary
  task?: Task
  link: boolean
  onClose: () => void
}) {
  return (
    <>
      {b && (
        <span className='flex shrink-0 items-center gap-1.5'>
          <ProjectLogo project={b} size={14} />
          {b.name}
        </span>
      )}
      <span className='truncate text-foreground/80'>
        {n.kind === 'worker'
          ? task
            ? `手上：${task.title}`
            : '空闲'
          : n.activity && `进度：${n.activity}`}
      </span>
      {n.lastSeenAt && (
        <span className='shrink-0'>心跳 {timeAgo(n.lastSeenAt)}</span>
      )}
      {link && b && (
        <Link
          to='/b/$businessId'
          params={{ businessId: b.id }}
          onClick={onClose}
          className='ms-auto shrink-0 hover:text-foreground'
        >
          打开业务 →
        </Link>
      )}
    </>
  )
}
