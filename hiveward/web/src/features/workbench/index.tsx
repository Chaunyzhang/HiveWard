import { useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { BusinessSummary, Decision, Task, TopologyNode } from '@shared/api'
import { Laptop } from 'lucide-react'
import {
  decisionsQuery,
  overviewQuery,
  tasksQuery,
  topologyQuery,
} from '@/lib/hiveward-api'
import { agentStatusStyle } from '@/lib/hiveward-format'
import { terminalsQuery, useHiveWardTerminals } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { MachineScope, useFleet } from '@/lib/machine'
import { insidePath } from '@/lib/project-for-path'
import { cn } from '@/lib/utils'
import {
  TopologyCanvas,
  type AddSpot,
  type MachineGroup,
} from '@/components/hiveward/topology-canvas'
import { Page } from '@/components/layout/page'
import { DecisionList } from '@/features/decisions/decision-list'
import { ProjectTerminals } from '@/features/terminal/project-terminals'
import { Timeline } from '@/features/timeline'
import { hivewardNodes } from './hiveward-nodes'
import { HomeHeader, type HomeTab } from './project-header'
import { SessionView, type OpenSession } from './session-view'
import { TaskFeed } from './task-feed'
import { TASK_FILTERS, taskFilterOf, type TaskFilter } from './task-status'
import { TopologyAdd } from './topology-add'

/**
 * 主页（集团 / 业务主页 / 项目主页共用）：顶上标题 + 一排标签，一个标签一样东西——
 * 架构图（默认）· 任务 · 现场（这个目录里的终端）。
 * 集团没有标签栏：架构图（首页）、任务各是左栏里的一项。项目主页的内容都只算这个项目的。
 * 任务就是时间线：「全部」是时间线，其余按状态筛（待决策 = 该你复核的、受阻的，加上 Agent 问你的事；待复核 = 派活的 Agent 自己会复核的）。
 * 每块功能一个大框，大框里不再套小框：小块都是"隐藏的框"，悬停才变灰显出来。
 * 点架构图节点，在中间栏打开这个 Agent（它开的网页在右栏）；标题行的返回箭头回到主页。
 * 集团总览把局域网里配对过、在线的电脑合在一起看：架构图里每台电脑一列，任务和待办标明来自哪台。
 */
export function Workbench(props: WorkbenchProps) {
  return props.session ? (
    <SessionView session={props.session} businessId={props.businessId} />
  ) : (
    <WorkbenchHome {...props} />
  )
}

type WorkbenchProps = {
  businessId?: string
  /** 看的是业务里的某个项目 */
  projectId?: string
  /** 主页的标签 */
  tab?: HomeTab
  /** 现场标签里选中的终端 */
  terminal?: string
  /** 任务页按状态筛 */
  status?: TaskFilter
  /** 集团任务页：只看某块业务 / 某个项目 */
  taskFilter?: { businessId?: string; projectId?: string }
  /** 中间栏打开的会话（地址栏里的 session / m） */
  session?: OpenSession
}

function WorkbenchHome({
  businessId,
  projectId,
  tab = 'topology',
  terminal,
  status = 'all',
  taskFilter,
}: WorkbenchProps) {
  const navigate = useNavigate()
  // 架构图上点了「+」：要加项目还是派下属
  const [adding, setAdding] = useState<AddSpot | null>(null)
  const allFleet = useFleet()
  // 业务页只看正在看的那台电脑
  const fleet = businessId ? allFleet.slice(0, 1) : allFleet
  const multi = fleet.length > 1
  const ids = fleet.map((f) => f.id)

  const overviews = useQueries({ queries: ids.map(overviewQuery) })
  const topologies = useQueries({
    queries: ids.map((m) => topologyQuery(m, businessId)),
  })
  const taskLists = useQueries({
    queries: ids.map((m) => tasksQuery(m, businessId)),
  })
  const decisionLists = useQueries({ queries: ids.map(decisionsQuery) })
  // 首页额外挂上 HiveWard 里真实在跑的 Agent（按项目分组），点开就是它的对话
  const terminalLists = useQueries({
    queries: ids.map((m) => ({ ...terminalsQuery(m), enabled: !businessId })),
  })

  const business = businessId
    ? overviews[0]?.data?.businesses.find((b) => b.id === businessId)
    : undefined
  const project = projectId
    ? business?.projects?.find((p) => p.id === projectId)
    : undefined
  // 任务页选的范围：业务页就是它自己，集团任务页看筛的
  const allBusinesses = dedupe(
    overviews.flatMap((o) => o.data?.businesses ?? [])
  ).filter((b) => b.status !== 'archived')
  const scopeBusinessId = businessId ?? taskFilter?.businessId
  const scopeProject =
    project ??
    allBusinesses
      .find((b) => b.id === taskFilter?.businessId)
      ?.projects?.find((p) => p.id === taskFilter?.projectId)
  // 项目主页的待办：问话的 Agent 开在这个项目目录里
  const { data: liveTerminals } = useHiveWardTerminals()
  const inProject = (d: Decision) => {
    if (!scopeProject) {
      return true
    }
    const t = liveTerminals?.find((x) => x.handle === d.dispatch?.handle)
    return !!t && insidePath(t.project, scopeProject.path)
  }

  const groups: MachineGroup[] = fleet.map((f, i) => {
    // 不属于任何业务的 Agent 单独成支；已经挂在业务下的不重复画
    // 旧版后台还会带一个老板节点，不画
    const all = (topologies[i].data?.nodes ?? []).filter(
      (n) => n.kind !== 'owner'
    )
    const rest = projectId ? projectNodes(all, projectId) : all
    const placed = new Set(rest.map((n) => n.terminal).filter(Boolean))
    const rows = rest.filter((n) => n.kind === 'leader')
    return {
      id: f.id,
      machine: f.machine,
      nodes: [
        ...rest,
        ...(businessId
          ? []
          : hivewardNodes(
              (terminalLists[i].data ?? []).filter(
                (t) => !placed.has(t.handle)
              ),
              rows
            )),
      ],
    }
  })
  const machineName = (i: number) =>
    fleet[i].machine?.name ?? (fleet[i].id ? tr('那台电脑') : tr('本机'))

  const workers = groups.flatMap((g) =>
    g.nodes.filter((n) => n.kind === 'worker')
  )
  const liveWorkers = workers.filter((n) => n.liveness === 'live').length

  // 任务合成一张列表；多台电脑时标明来自哪台，业务名到各自那台电脑上找
  const tasks = taskLists.flatMap((q, i) =>
    (q.data ?? [])
      .filter(
        (task) =>
          (!scopeBusinessId || task.businessId === scopeBusinessId) &&
          (!scopeProject || task.projectId === scopeProject.id)
      )
      .map((task) => ({ task, i }))
  )
  const origin = new Map(tasks.map(({ task, i }) => [task, i]))
  const businessesOf = (i: number) => overviews[i]?.data?.businesses ?? []

  const pendingOf = (i: number) =>
    (decisionLists[i].data ?? []).filter(
      (d) =>
        d.state === 'pending' &&
        (!scopeBusinessId || d.businessId === scopeBusinessId) &&
        inProject(d)
    ).length
  const pending = fleet.reduce((sum, _, i) => sum + pendingOf(i), 0)
  const withPending = fleet.flatMap((f, i) => (pendingOf(i) ? [{ f, i }] : []))

  const errors = (queries: { error: Error | null }[]) =>
    queries.map((q, i) => (
      <LoadError
        key={i}
        query={q}
        prefix={multi ? machineName(i) : undefined}
      />
    ))

  // 停下来问你的派单已经在「Agent 问你的事」里了，任务列表里不再重复列
  const asked = new Set(
    decisionLists.flatMap((q) =>
      (q.data ?? []).filter((d) => d.state === 'pending').map((d) => d.id)
    )
  )
  const inFilter = (t: Task, f: TaskFilter) =>
    taskFilterOf(t) === f && !(f === 'mine' && asked.has(t.id))
  // 每个状态筛选里有几条；待决策连带 Agent 问你的事
  const countOf = (f: TaskFilter) =>
    tasks.filter(({ task }) => inFilter(task, f)).length +
    (f === 'mine' ? pending : 0)
  const todo = countOf('mine')

  const header = (
    <HomeHeader
      business={business}
      project={project}
      tab={tab}
      counts={{ tasks: todo }}
    />
  )
  const goTasks = (next: {
    businessId?: string
    projectId?: string
    status?: TaskFilter
  }) => {
    const st = next.status === 'all' ? undefined : next.status
    if (businessId) {
      void navigate({
        to: '/b/$businessId',
        params: { businessId },
        search: { project: next.projectId, tab: 'tasks', status: st },
      })
      return
    }
    void navigate({
      to: '/tasks',
      search: {
        business: next.businessId,
        project: next.projectId,
        status: st,
      },
    })
  }
  const taskById = new Map(tasks.map(({ task }) => [task.id, task]))
  const filtered = tasks.map((x) => x.task).filter((t) => inFilter(t, status))
  const decisionBlock = (
    <Panel title={tr('Agent 问你的事')} meta={tr('{0} 件', [pending])}>
      <div className='px-2 pb-3'>
        {errors(decisionLists)}
        {withPending.map(({ f, i }) => (
          <MachineScope key={f.id ?? 'self'} id={f.id}>
            {multi && (
              <h3 className='mt-2 flex items-center gap-1.5 px-2 text-xs text-muted-foreground'>
                <Laptop className='size-3' />
                {machineName(i)}
              </h3>
            )}
            <DecisionList
              businessId={scopeBusinessId}
              match={scopeProject ? inProject : undefined}
            />
          </MachineScope>
        ))}
      </div>
    </Panel>
  )
  const taskPage = (
    <div className='space-y-5'>
      <div className='flex flex-wrap items-center gap-3'>
        {/* 栏窄时这排横着滚，不把「进行中」挤成一字一行 */}
        <div className='flex max-w-full gap-1 overflow-x-auto rounded-md bg-muted p-0.5 whitespace-nowrap'>
          {TASK_FILTERS.map((f) => {
            const n = f.value === 'all' ? 0 : countOf(f.value)
            return (
              <button
                key={f.value}
                type='button'
                onClick={() =>
                  goTasks({
                    businessId: scopeBusinessId,
                    projectId: scopeProject?.id,
                    status: f.value,
                  })
                }
                className={cn(
                  'flex h-7 shrink-0 items-center gap-1.5 rounded-[5px] px-3 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground',
                  status === f.value && 'bg-panel text-foreground shadow-sm'
                )}
              >
                {f.label}
                {n > 0 && (
                  <span
                    className={cn(
                      'font-mono text-[11px]',
                      f.value === 'mine'
                        ? 'text-attention'
                        : 'text-muted-foreground'
                    )}
                  >
                    {n}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div className='ms-auto flex items-center gap-2'>
          {!businessId && (
            <select
              aria-label={tr('业务')}
              value={scopeBusinessId ?? ''}
              onChange={(e) =>
                goTasks({ businessId: e.target.value || undefined, status })
              }
              className='h-8 max-w-56 rounded-md border bg-transparent px-2 text-[13px]'
            >
              <option value=''>{tr('全部业务')}</option>
              {allBusinesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          {scopeBusinessId && (
            <select
              aria-label={tr('项目')}
              value={scopeProject?.id ?? ''}
              onChange={(e) =>
                goTasks({
                  businessId: scopeBusinessId,
                  projectId: e.target.value || undefined,
                  status,
                })
              }
              className='h-8 max-w-44 rounded-md border bg-transparent px-2 text-[13px]'
            >
              <option value=''>{tr('全部项目')}</option>
              {(
                allBusinesses.find((b) => b.id === scopeBusinessId)?.projects ??
                []
              )
                .filter((p) => p.status !== 'archived')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          )}
        </div>
      </div>
      {errors(taskLists)}
      {status === 'all' ? (
        <Timeline
          scope={{ businessId: scopeBusinessId, projectId: scopeProject?.id }}
          taskOf={(id) => taskById.get(id)}
        />
      ) : (
        <>
          {status === 'mine' && pending > 0 && decisionBlock}
          <TaskFeed
            tasks={filtered}
            showBusiness={!businessId}
            businessOf={(t) =>
              businessesOf(origin.get(t) ?? 0).find(
                (b) => b.id === t.businessId
              )
            }
            machineOf={
              multi ? (t) => machineName(origin.get(t) ?? 0) : undefined
            }
            empty={
              status === 'mine'
                ? tr('没有待决策的事。')
                : status === 'review'
                  ? tr('没有待复核的活。派活的 Agent 复核完会自己清掉。')
                  : tr('没有{0}的任务。', [
                      TASK_FILTERS.find((f) => f.value === status)?.label,
                    ])
            }
          />
        </>
      )}
    </div>
  )
  // 现场、架构图填满窗口剩下的高度
  if (business && tab === 'live') {
    return (
      <Page className='flex h-full flex-col gap-5'>
        {header}
        <ProjectTerminals
          businessId={business.id}
          projectId={project?.id}
          workspacePath={project?.path ?? business.workspacePath}
          selected={terminal}
        />
      </Page>
    )
  }

  if (tab === 'topology') {
    return (
      <Page className='flex h-full flex-col gap-5'>
        {header}
        <Panel
          title={tr('Agent 架构')}
          meta={tr('{0}{1}/{2} 个下属在线', [
            multi ? tr('{0} 台电脑 · ', [fleet.length]) : '',
            liveWorkers,
            workers.length,
          ])}
          actions={<Legend />}
          className='min-h-0 flex-1'
        >
          {errors(topologies)}
          <TopologyCanvas
            groups={groups}
            project={!!project}
            onOpen={(node, machine) =>
              void navigate({
                to: '.',
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  session: node.id,
                  m: machine ?? undefined,
                }),
              })
            }
            onAdd={setAdding}
          />
          <TopologyAdd spot={adding} onClose={() => setAdding(null)} />
        </Panel>
      </Page>
    )
  }

  return (
    <Page className='space-y-5'>
      {header}
      {tab === 'tasks' && taskPage}
    </Page>
  )
}

/** 项目主页的架构图：业务根节点 + 这个项目的 Leader Agent 和它下面的下属（连带并联的 Grok Bot） */
function projectNodes(nodes: TopologyNode[], projectId: string) {
  const keep = new Set(
    nodes
      .filter((n) => n.kind === 'leader' && n.projectId === projectId)
      .map((n) => n.id)
  )
  // 下属挂在 Leader Agent 下面，可能隔几层：一直往下找
  for (let grew = true; grew; ) {
    grew = false
    for (const n of nodes) {
      if (n.parentId && keep.has(n.parentId) && !keep.has(n.id)) {
        keep.add(n.id)
        grew = true
      }
    }
  }
  // 业务根留着，只用来算项目子目录；画的时候从项目卡开始
  return nodes.filter(
    (n) => keep.has(n.id) || n.kind === 'business' || n.kind === 'project'
  )
}

/** 读失败要说出来，不能默默显示成"没有" */
function LoadError({
  query,
  prefix,
}: {
  query: { error: Error | null }
  prefix?: string
}) {
  if (!query.error) return null
  return (
    <p className='px-4 py-2 text-xs text-danger'>
      {tr('{0}读取失败：{1}', [prefix && `${prefix}：`, query.error.message])}
    </p>
  )
}

function Panel({
  title,
  meta,
  actions,
  children,
  className,
}: {
  title: string
  meta?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-xl panel',
        className
      )}
    >
      <header className='flex h-12 shrink-0 items-center gap-3 px-4'>
        <h2 className='text-[13px] font-medium'>{title}</h2>
        {meta && <span className='text-xs text-muted-foreground'>{meta}</span>}
        {actions && (
          <div className='ms-auto flex items-center gap-3'>{actions}</div>
        )}
      </header>
      {children}
    </section>
  )
}

function Legend() {
  return (
    <span className='hidden items-center gap-3 text-[11px] text-muted-foreground @3xl:flex'>
      {Object.values(agentStatusStyle).map((l) => (
        <span key={l.label} className='flex items-center gap-1.5'>
          <span className={cn('size-1.5 rounded-full', l.dot)} />
          {l.label}
        </span>
      ))}
    </span>
  )
}

/** 几台电脑的概况合在一起时，同一块业务只留一份 */
function dedupe(list: BusinessSummary[]) {
  const seen = new Set<string>()
  return list.filter((b) => !seen.has(b.id) && !!seen.add(b.id))
}
