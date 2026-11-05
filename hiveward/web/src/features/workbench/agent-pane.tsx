import { Link } from '@tanstack/react-router'
import type { BusinessSummary, Project, Task, TopologyNode } from '@shared/api'
import { toast } from 'sonner'
import { useLaunchProjectLeader, useWorkerScreen } from '@/lib/hiveward-api'
import {
  agentStatus,
  agentStatusStyle,
  LEADER_LABEL,
  LEADERS,
  timeAgo,
} from '@/lib/hiveward-format'
import { useHiveWardTerminals, useSeatChat } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { AgentLogo } from '@/components/hiveward/agent-logo'
import { ProjectLogo } from '@/components/hiveward/project-logo'
import { PaneHeader } from '@/components/layout/top-bar-slot'
import { useSessionAsks } from '@/features/decisions/session-asks'
import {
  AgentConsole,
  BackButton,
  ConsoleView,
} from '@/features/live/agent-console'
import { useSeatTitle } from '@/features/session/use-seat-title'
import { CloseWorkerButton } from '@/features/session/worker-close'
import { TaskList } from './dispatched-tasks'
import { NoCeo } from './no-ceo'
import { PersonalAgentPane } from './personal-agent'
import { CopySeatPrompt } from './seat-prompt'

/**
 * 点架构图节点，在中间栏打开（不套框，整个中间栏都给它）：这个 Agent 的实时输出（对话 / 终端）；
 * 它开的网页在右栏浏览器里。接了终端的直接连真终端；其余的读负责人 / 下属的终端画面。
 * 标题行最前面是返回箭头，回到打开它的那个主页。
 */
export function AgentPane({
  node,
  tasks,
  businesses,
  showBusinessLink,
  onClose,
  tools,
  title: given,
}: {
  node: TopologyNode
  tasks: Task[]
  businesses: BusinessSummary[]
  showBusinessLink: boolean
  onClose: () => void
  /** 标题行最右边的会话工具栏 */
  tools?: React.ReactNode
  /** 标题写什么：不传按它坐的位子；远程下属传本机这边的写法 */
  title?: string
}) {
  const business = businesses.find((b) => b.id === node.businessId)
  const task =
    node.kind === 'worker' ? tasks.find((t) => t.id === node.taskId) : undefined
  const back = <BackButton onClick={onClose} />
  // 标题写它坐的位子（「业务 · 项目 · Leader」），没坐座位的写它自己的名字
  const seat = useSeatTitle().ofNode(node)
  const title = given ?? seat
  return (
    <div className='flex h-full min-h-0 flex-col'>
      {node.kind === 'grok' ? (
        <PersonalAgentPane
          key={node.id}
          node={node}
          business={business}
          leading={back}
          trailing={tools}
          tasks={tasks.filter(
            (t) =>
              t.dispatchedBy?.kind === 'grok' &&
              t.businessId === node.businessId
          )}
        />
      ) : node.sessionId && (node.kind === 'ceo' || node.kind === 'leader') ? (
        <SeatSession node={node} title={title} leading={back} tools={tools} />
      ) : node.dispatcher || node.sessionId ? (
        <Dispatcher
          node={node}
          title={title ?? node.label}
          leading={back}
          tools={tools}
          tasks={tasks.filter(
            (t) => t.dispatchedBy?.id === (node.sessionId ?? node.dispatcher)
          )}
        />
      ) : node.terminal ? (
        <LiveAgent
          key={node.id}
          node={node}
          business={business}
          title={given}
          leading={back}
          tools={tools}
          tasks={tasks}
        />
      ) : node.kind === 'ceo' ? (
        <Bare leading={back} title={title ?? node.label} tools={tools}>
          <NoCeo business={business} exited={node.liveness === 'exited'} />
        </Bare>
      ) : node.kind === 'leader' ? (
        <Bare leading={back} title={title ?? node.label} tools={tools}>
          <NoLeader
            business={business}
            project={business?.projects?.find((p) => p.id === node.projectId)}
            exited={node.liveness === 'exited'}
          />
        </Bare>
      ) : (
        <ScreenAgent
          key={node.id}
          node={node}
          title={title ?? node.label}
          leading={back}
          tools={tools}
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

/** 没有控制台的节点（空位等）：标题行只有返回箭头和名字 */
function Bare({
  leading,
  title,
  tools,
  children,
}: {
  leading: React.ReactNode
  title: string
  tools?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <>
      <PaneHeader className='gap-2.5'>
        {leading}
        <h2 className='min-w-0 flex-1 truncate text-[13px] font-medium'>
          {title}
        </h2>
        {tools}
      </PaneHeader>
      <div className='min-h-0 flex-1'>{children}</div>
    </>
  )
}

/** 接了 HiveWard 终端的节点：真终端，能看能说 */
function LiveAgent({
  node,
  business,
  title,
  leading,
  tools,
  tasks,
}: {
  node: TopologyNode
  business?: BusinessSummary
  title?: string
  leading: React.ReactNode
  tools?: React.ReactNode
  tasks: Task[]
}) {
  const terminals = useHiveWardTerminals()
  const seat = useSeatTitle()
  const terminal = terminals.data?.find((t) => t.handle === node.terminal)
  const asks = useSessionAsks({
    handle: terminal?.handle,
    tasks,
    seat: node.kind === 'leader' || node.kind === 'ceo',
  })
  return terminal ? (
    <AgentConsole
      terminal={terminal}
      title={title ?? seat.ofNode(node)}
      leading={leading}
      trailing={
        <>
          <CloseWorkerButton node={node} />
          {tools}
        </>
      }
      className='h-full'
      asks={asks}
    />
  ) : (
    <Bare
      leading={leading}
      title={title ?? seat.ofNode(node) ?? node.label}
      tools={tools}
    >
      {terminals.isLoading ? (
        <p className='p-6 text-[13px] text-muted-foreground'>
          {tr('连接引擎…')}
        </p>
      ) : node.kind === 'ceo' ? (
        // 座位上的终端关了：和空位一样，让老板开一个 Agent 坐回去
        <NoCeo business={business} exited />
      ) : node.kind === 'leader' ? (
        <NoLeader
          business={business}
          project={business?.projects?.find((p) => p.id === node.projectId)}
          exited
        />
      ) : (
        <p className='p-6 text-[13px] text-muted-foreground'>
          {tr('这个终端已经关掉了。')}
        </p>
      )}
    </Bare>
  )
}

/** 没有直连终端的节点：读负责人 / 下属的终端画面和对话记录 */
function ScreenAgent({
  node: n,
  title,
  leading,
  tools,
  context,
}: {
  node: TopologyNode
  title: string
  leading: React.ReactNode
  tools?: React.ReactNode
  context: React.ReactNode
}) {
  const screen = useWorkerScreen(n.dispatchId ?? null)
  // 桌面端会话本来就核实不了在线，不算失联
  const stale = n.liveness === 'unverifiable' && !n.sessionId
  const status =
    agentStatus({
      state: n.state,
      liveness: n.liveness,
      session: !!n.sessionId,
    }) ?? 'idle'
  return (
    <ConsoleView
      leading={leading}
      agent={n.agent}
      title={title}
      subtitle={n.sublabel}
      tone={status}
      status={
        stale
          ? tr('故障 · 失联，心跳 {0}', [
              n.lastSeenAt ? timeAgo(n.lastSeenAt) : tr('未知'),
            ])
          : agentStatusStyle[status].label
      }
      context={context}
      chat={screen.data?.items ?? null}
      loading={screen.isPending}
      screen={
        screen.isError
          ? tr('读不到终端：{0}', [screen.error.message])
          : (screen.data?.text ?? tr('读取画面…'))
      }
      working={status === 'working'}
      placeholder={tr('这个 Agent 没有直连的终端，只能看，不能直接说话')}
      trailing={tools}
      className='h-full'
    />
  )
}

/**
 * 坐在 CEO / Leader 位上的外部会话（Claude 桌面端等）：和别的 Agent 一样点开就是它的对话，
 * 读它自己的对话记录，只能看——它的输入框在 Claude 桌面端里，HiveWard 替它打不了字。
 * 它派出去、还在跑的活在工具栏「更多 → 后台任务」里。
 */
function SeatSession({
  node: n,
  title,
  leading,
  tools,
}: {
  node: TopologyNode
  title?: string
  leading: React.ReactNode
  tools?: React.ReactNode
}) {
  const chat = useSeatChat(n.id)
  const tone =
    agentStatus({
      state: n.state,
      liveness: n.liveness,
      session: !!n.sessionId,
    }) ?? 'idle'
  // 拼进中文句子里：英文前面空一格
  const where =
    n.agent === 'claude-desktop' ? tr(' Claude 桌面端') : tr('它自己的窗口')
  return (
    <ConsoleView
      leading={leading}
      agent={n.agent}
      title={
        title ??
        `${n.kind === 'ceo' ? 'CEO' : 'Leader'} · ${n.kind === 'ceo' ? (n.sublabel ?? n.label) : n.label}`
      }
      subtitle={tr('在{0}里', [where])}
      tone={tone}
      status={
        tone === 'working'
          ? tr('干活')
          : n.state === 'pending'
            ? tr('等待 · 在问你')
            : tone === 'failed'
              ? tr('好久没动静')
              : tr('空闲')
      }
      chat={chat.data?.source ? chat.data.items : []}
      plan={chat.data?.plan}
      loading={chat.isPending}
      working={tone === 'working'}
      placeholder=''
      readOnly={
        chat.isError
          ? tr('读不到它的对话：{0}', [chat.error.message])
          : tr('这个会话开在{0}里，要跟它说话请回{1}', [where, where])
      }
      className='h-full'
      trailing={tools}
    />
  )
}

/** 派单方（开在项目目录里的 Claude Code 会话，没坐座位）：对话在它自己那边，这里只列它派出去的活和结果 */
function Dispatcher({
  node: n,
  title,
  leading,
  tools,
  tasks,
}: {
  node: TopologyNode
  title: string
  leading: React.ReactNode
  tools?: React.ReactNode
  tasks: Task[]
}) {
  return (
    <div className='flex h-full flex-col'>
      <PaneHeader className='gap-2.5'>
        {leading}
        <AgentLogo agent={n.agent} className='size-4 shrink-0' />
        <h2 className='min-w-0 truncate text-[13px] font-medium'>{title}</h2>
        <span className='min-w-0 flex-1 truncate text-xs text-muted-foreground'>
          {tr('对话在{0}进行，这里看它派出去的活', [n.sublabel ?? n.label])}
        </span>
        {tools}
      </PaneHeader>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        <div className='mx-auto w-full max-w-[46rem] px-4 py-6'>
          <TaskList tasks={tasks} />
        </div>
      </div>
    </div>
  )
}

/** 项目还没开 Leader Agent（或 Leader Agent 退出了）：选一家开一个；「未归项目」没有 Leader Agent 可开 */
function NoLeader({
  business,
  project,
  exited,
}: {
  business?: BusinessSummary
  project?: Project
  exited: boolean
}) {
  const launch = useLaunchProjectLeader()
  if (!project) {
    return (
      <p className='p-6 text-[13px] text-muted-foreground'>
        {tr('这些 Agent 开在业务目录里，但不属于任何项目。')}
      </p>
    )
  }
  return (
    <div className='flex h-full flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground'>
      <p>
        「{project.name}」
        {exited
          ? tr('的 Leader Agent 已经退出了。')
          : tr('还没开 Leader Agent。')}
      </p>
      {business && (
        <>
          <p className='max-w-md text-center text-xs leading-5'>
            {tr(
              '复制提示词，贴给你正在用的 Agent（Claude Code / ChatGPT 会话），它会照着坐上来。'
            )}
          </p>
          <CopySeatPrompt business={business} project={project} />
          <p className='mt-3 text-xs'>{tr('或者在这里开一个终端坐上去：')}</p>
        </>
      )}
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
                    toast.success(
                      tr('Leader Agent 已开，稍等它出现在架构图里')
                    ),
                  onError: (e) => toast.error(tr('没开成：{0}', [e.message])),
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
            ? tr('手上：{0}', [task.title])
            : tr('空闲')
          : n.activity && tr('进度：{0}', [n.activity])}
      </span>
      {n.lastSeenAt && (
        <span className='shrink-0'>
          {tr('心跳 {0}', [timeAgo(n.lastSeenAt)])}
        </span>
      )}
      {link && b && (
        <Link
          to='/b/$businessId'
          params={{ businessId: b.id }}
          onClick={onClose}
          className='ms-auto shrink-0 hover:text-foreground'
        >
          {tr('打开业务 →')}
        </Link>
      )}
    </>
  )
}
