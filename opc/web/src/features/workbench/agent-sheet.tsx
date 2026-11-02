import { Link } from '@tanstack/react-router'
import type { BusinessSummary, Task, TopologyNode } from '@shared/api'
import { toast } from 'sonner'
import { useAgentScreen, useLaunchLeader } from '@/lib/opc-api'
import { agentStatus, agentStatusStyle, timeAgo } from '@/lib/opc-format'
import { useOrcaTerminals } from '@/lib/orca-live'
import { cn } from '@/lib/utils'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { AgentLogo, AgentName } from '@/components/opc/agent-logo'
import { ProjectLogo } from '@/components/opc/project-logo'
import { AgentConsole, ConsoleView } from '@/features/live/agent-console'
import { Markdown } from '@/features/live/chat-view'
import { statusIcon } from './task-status'

/**
 * 点架构图节点打开：这个 Agent 的实时输出（对话 / 终端），和现场页同一个控制台。
 * 接了 Orca 终端的直接连真终端；其余的读负责人 / 下属的终端画面。
 */
export function AgentSheet({
  node,
  tasks,
  businesses,
  showBusinessLink,
  onClose,
}: {
  node: TopologyNode | null
  tasks: Task[]
  businesses: BusinessSummary[]
  showBusinessLink: boolean
  onClose: () => void
}) {
  const business = businesses.find((b) => b.id === node?.businessId)
  const task =
    node?.kind === 'worker'
      ? tasks.find((t) => t.id === node.taskId)
      : undefined
  return (
    <Sheet open={!!node} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className='flex w-full flex-col gap-0 p-0 sm:max-w-[min(960px,80vw)]'>
        {node && (
          <>
            <SheetHeader className='sr-only'>
              <SheetTitle>{node.label}</SheetTitle>
              <SheetDescription>{node.activity}</SheetDescription>
            </SheetHeader>
            {node.kind === 'grok' || node.dispatcher ? (
              <Dispatcher
                node={node}
                business={business}
                tasks={tasks.filter((t) =>
                  node.kind === 'grok'
                    ? t.dispatchedBy?.kind === 'grok' &&
                      t.businessId === node.businessId
                    : t.dispatchedBy?.id === node.dispatcher
                )}
              />
            ) : node.terminal ? (
              <LiveAgent key={node.id} node={node} />
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
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** 接了 Orca 终端的节点：真终端，能看能说 */
function LiveAgent({ node }: { node: TopologyNode }) {
  const terminals = useOrcaTerminals()
  const terminal = terminals.data?.find((t) => t.handle === node.terminal)
  return terminal ? (
    <AgentConsole
      terminal={terminal}
      className='h-full'
      headerClassName='pe-12'
    />
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
  const screen = useAgentScreen(
    n.kind === 'leader' && n.businessId
      ? { kind: 'leader', businessId: n.businessId }
      : n.kind === 'worker' && n.dispatchId
        ? { kind: 'worker', dispatchId: n.dispatchId }
        : null
  )
  const stale = n.liveness === 'unverifiable'
  const status = agentStatus({ state: n.state, liveness: n.liveness }) ?? 'idle'
  // 业务还没有负责人：没有画面可看，直接给派负责人的入口
  if (
    n.kind === 'leader' &&
    (!n.liveness || n.liveness === 'exited') &&
    n.businessId
  )
    return <NoLeader businessId={n.businessId} name={n.label} />
  return (
    <ConsoleView
      agent={n.agent}
      title={n.kind === 'leader' ? `${n.label} · 负责人` : n.label}
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
      headerClassName='pe-12'
    />
  )
}

/** 派单方（这块业务的 Grok Bot / 开在项目目录里的 Claude Code 会话）：对话在它自己那边，这里只列它派出去的活和结果 */
function Dispatcher({
  node: n,
  tasks,
  business,
}: {
  node: TopologyNode
  tasks: Task[]
  business?: BusinessSummary
}) {
  const sorted = [...tasks].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )
  return (
    <div className='flex h-full flex-col'>
      <header className='flex h-12 shrink-0 items-center gap-3 px-4 pe-12'>
        <AgentLogo agent={n.agent} className='size-4' />
        <h2 className='text-[13px] font-medium'>{n.label}</h2>
        {n.sublabel && (
          <span className='text-xs text-muted-foreground'>{n.sublabel}</span>
        )}
        <span className='text-xs text-muted-foreground'>
          {n.kind === 'grok'
            ? `老板在 Grok Bot 里下指令，它把活交给${business?.name ?? '这块业务'}的 Agent；这里看它派出去的活`
            : `对话在${n.sublabel ?? n.label}进行，这里看它派出去的活`}
        </span>
      </header>
      <ul className='min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-6'>
        {sorted.length === 0 && (
          <li className='px-2 py-6 text-[13px] text-muted-foreground'>
            还没派过活。
          </li>
        )}
        {sorted.map((t) => {
          const s = statusIcon[t.status]
          const Icon = s.icon
          return (
            <li key={t.id} className='rounded-md px-2 py-2.5 hover:bg-accent'>
              <div className='flex items-start gap-3'>
                <Icon
                  className={cn('mt-0.5 size-4 shrink-0', s.className)}
                  aria-label={s.label}
                />
                <div className='min-w-0 flex-1'>
                  <p className='flex items-baseline gap-2 text-[13px] leading-5'>
                    <span className='truncate'>{t.title}</span>
                    <span className='ms-auto shrink-0 text-[11px] text-muted-foreground'>
                      <AgentName agent={t.assignee?.agent} />
                      {t.project && <> · {t.project}</>} ·{' '}
                      {timeAgo(t.updatedAt)}
                    </span>
                  </p>
                  {t.report && (
                    <div className='mt-1.5 text-[13px] leading-6 text-foreground/85'>
                      <Markdown text={t.report.summary} />
                    </div>
                  )}
                  {t.blockedReason && (
                    <p className='mt-1 text-xs text-attention'>
                      {t.blockedReason}
                    </p>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function NoLeader({ businessId, name }: { businessId: string; name: string }) {
  const launch = useLaunchLeader()
  return (
    <div className='flex h-full flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground'>
      <p>「{name}」现在没有在岗的负责人。</p>
      <button
        type='button'
        disabled={launch.isPending}
        onClick={() =>
          launch.mutate(businessId, {
            onSuccess: () => toast.success('负责人已开，稍等它出现在架构图里'),
            onError: (e) => toast.error(`没派成：${e.message}`),
          })
        }
        className='h-8 rounded-md bg-foreground px-4 text-xs text-background disabled:opacity-40'
      >
        {launch.isPending ? '正在开…' : '派负责人'}
      </button>
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
