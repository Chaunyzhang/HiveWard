import { useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Decision, OrcaTerminal, Project, TopologyNode } from '@shared/api'
import { ArrowLeft, Laptop } from 'lucide-react'
import { MachineScope, useCurrentMachineId, useFleet } from '@/lib/machine'
import {
  decisionsQuery,
  overviewQuery,
  tasksQuery,
  topologyQuery,
} from '@/lib/opc-api'
import { agentStatusStyle } from '@/lib/opc-format'
import { terminalsQuery, useOrcaTerminals } from '@/lib/orca-live'
import { insidePath } from '@/lib/project-for-path'
import { cn } from '@/lib/utils'
import { Page } from '@/components/layout/page'
import {
  TopologyCanvas,
  type MachineGroup,
} from '@/components/opc/topology-canvas'
import { DecisionList } from '@/features/decisions/decision-list'
import { ProjectTerminals } from '@/features/terminal/project-terminals'
import { Timeline } from '@/features/timeline'
import { AgentPane } from './agent-pane'
import { ProjectHeader, type ProjectTab } from './project-header'
import { NewProjectButton, ProjectList } from './projects-panel'
import { TaskFeed } from './task-feed'
import { countTab, taskTabs, type TaskTab } from './task-status'

/**
 * 主页（集团总览 / 业务主页 / 项目主页共用）。概览只放三样东西——
 * Agent 架构图（谁在做什么）· 待办（要我决定的事）· 任务与汇报（做了什么）；业务主页多一块项目列表。
 * 业务、项目主页另有「现场」（这个目录里的终端）和「时间线」两个标签；项目主页的内容都只算这个项目的。
 * 每块功能一个大框，大框里不再套小框：小块都是"隐藏的框"，悬停才变灰显出来。
 * 点架构图节点，在中间栏打开这个 Agent（它开的网页在右栏）；「← 返回」回到主页。
 * 集团总览把局域网里配对过、在线的电脑合在一起看：架构图里每台电脑一列，任务和待办标明来自哪台。
 */
export function Workbench({
  businessId,
  projectId,
  tab = 'overview',
  terminal,
}: {
  businessId?: string
  /** 看的是业务里的某个项目 */
  projectId?: string
  /** 业务 / 项目主页的标签 */
  tab?: ProjectTab
  /** 现场标签里选中的终端 */
  terminal?: string
}) {
  const [open, setOpen] = useState<Opened | null>(null)
  const [taskTab, setTaskTab] = useState<TaskTab>('all')
  const viewing = useCurrentMachineId()
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
  // 首页额外挂上 Orca 里真实在跑的 Agent（按项目分组），点开就是它的对话
  const terminalLists = useQueries({
    queries: ids.map((m) => ({ ...terminalsQuery(m), enabled: !businessId })),
  })

  const business = businessId
    ? overviews[0]?.data?.businesses.find((b) => b.id === businessId)
    : undefined
  const project = projectId
    ? business?.projects?.find((p) => p.id === projectId)
    : undefined
  // 项目主页的待办：问话的 Agent 开在这个项目目录里
  const { data: liveTerminals } = useOrcaTerminals()
  const inProject = (d: Decision) => {
    if (!project) {
      return true
    }
    const t = liveTerminals?.find((x) => x.handle === d.dispatch?.handle)
    return !!t && insidePath(t.project, project.path)
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
          : orcaNodes(
              (terminalLists[i].data ?? []).filter(
                (t) => !placed.has(t.handle)
              ),
              rows
            )),
      ],
    }
  })
  const machineName = (i: number) =>
    fleet[i].machine?.name ?? (fleet[i].id ? '那台电脑' : '本机')

  const workers = groups.flatMap((g) =>
    g.nodes.filter((n) => n.kind === 'worker')
  )
  const liveWorkers = workers.filter((n) => n.liveness === 'live').length

  // 任务合成一张列表；多台电脑时标明来自哪台，业务名到各自那台电脑上找
  const tasks = taskLists.flatMap((q, i) =>
    (q.data ?? [])
      .filter((task) => !projectId || task.projectId === projectId)
      .map((task) => ({ task, i }))
  )
  const origin = new Map(tasks.map(({ task, i }) => [task, i]))
  const businessesOf = (i: number) => overviews[i]?.data?.businesses ?? []

  const pendingOf = (i: number) =>
    (decisionLists[i].data ?? []).filter(
      (d) =>
        d.state === 'pending' &&
        (!businessId || d.businessId === businessId) &&
        inProject(d)
    ).length
  const pending = fleet.reduce((sum, _, i) => sum + pendingOf(i), 0)
  const withPending = fleet.flatMap((f, i) => (pendingOf(i) ? [{ f, i }] : []))

  const openIndex = open ? ids.indexOf(open.machine) : -1
  // 点项目：打开它的 Leader Agent（架构图里的那个节点；后台还没给节点时按项目现拼一个）
  const openProject = (p: Project) => {
    const node =
      groups[0]?.nodes.find(
        (n) => n.kind === 'leader' && n.projectId === p.id
      ) ??
      ({
        id: `leader:${p.id}`,
        kind: 'leader',
        projectId: p.id,
        businessId: p.businessId,
        label: p.name,
        agent: p.leader?.agent,
        liveness: p.leader?.liveness,
        terminal:
          p.leader && p.leader.liveness !== 'exited'
            ? p.leader.terminal
            : undefined,
      } satisfies TopologyNode)
    setOpen({ node, machine: ids[0] })
  }

  // 点开的 Agent 占满中间栏
  if (open) {
    return (
      <Page className='flex h-full flex-col gap-3 py-5'>
        <button
          type='button'
          onClick={() => setOpen(null)}
          className='flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground'
        >
          <ArrowLeft className='size-3.5' />
          返回{project?.name ?? business?.name ?? '总览'}
        </button>
        <MachineScope id={open.machine ?? viewing}>
          <AgentPane
            node={open.node}
            tasks={openIndex >= 0 ? (taskLists[openIndex].data ?? []) : []}
            businesses={openIndex >= 0 ? businessesOf(openIndex) : []}
            // 业务页链接只对正在看的那台电脑有效
            showBusinessLink={!businessId && open.machine === viewing}
            onClose={() => setOpen(null)}
          />
        </MachineScope>
      </Page>
    )
  }

  if (business && tab === 'live') {
    // 终端填满窗口剩下的高度
    return (
      <Page className='flex h-full flex-col gap-5'>
        <ProjectHeader business={business} project={project} tab={tab} />
        <ProjectTerminals
          businessId={business.id}
          projectId={project?.id}
          workspacePath={project?.path ?? business.workspacePath}
          selected={terminal}
        />
      </Page>
    )
  }

  if (business && tab === 'timeline') {
    return (
      <Page className='mx-auto max-w-4xl space-y-5'>
        <ProjectHeader business={business} project={project} tab={tab} />
        <Timeline scope={{ businessId: business.id, projectId: project?.id }} />
      </Page>
    )
  }

  return (
    <Page className='space-y-5'>
      {business && (
        <ProjectHeader business={business} project={project} tab={tab} />
      )}
      <div className='grid gap-5 @5xl:grid-cols-[minmax(0,1fr)_340px]'>
        <Panel
          title='Agent 架构'
          meta={`${multi ? `${fleet.length} 台电脑 · ` : ''}${liveWorkers}/${workers.length} 个下属在线`}
          actions={<Legend />}
        >
          {topologies.map((q, i) => (
            <LoadError
              key={i}
              query={q}
              prefix={multi ? machineName(i) : undefined}
            />
          ))}
          <TopologyCanvas
            groups={groups}
            open={open ?? undefined}
            onOpen={(node, machine) => setOpen({ node, machine })}
          />
        </Panel>

        <div className='flex min-w-0 flex-col gap-5'>
          {business && !project && (
            <Panel
              title='项目'
              meta={
                business.projects?.length
                  ? String(
                      business.projects.filter((p) => p.status === 'active')
                        .length
                    )
                  : undefined
              }
              actions={<NewProjectButton business={business} />}
            >
              <ProjectList business={business} onOpen={openProject} />
            </Panel>
          )}
          <Panel
            title='待办'
            meta={pending ? `${pending} 件要你决定` : undefined}
          >
            <div className='max-h-[560px] overflow-y-auto px-2 pb-3'>
              {decisionLists.map((q, i) => (
                <LoadError
                  key={i}
                  query={q}
                  prefix={multi ? machineName(i) : undefined}
                />
              ))}
              {withPending.length === 0 ? (
                <MachineScope id={ids[0]}>
                  <DecisionList
                    businessId={businessId}
                    match={project ? inProject : undefined}
                  />
                </MachineScope>
              ) : (
                withPending.map(({ f, i }) => (
                  <MachineScope key={f.id ?? 'self'} id={f.id}>
                    {multi && (
                      <h3 className='mt-2 flex items-center gap-1.5 px-2 text-xs text-muted-foreground'>
                        <Laptop className='size-3' />
                        {machineName(i)}
                      </h3>
                    )}
                    <DecisionList
                      businessId={businessId}
                      match={project ? inProject : undefined}
                    />
                  </MachineScope>
                ))
              )}
            </div>
          </Panel>
        </div>
      </div>

      <Panel
        title='任务与汇报'
        actions={
          <Segmented
            value={taskTab}
            onChange={setTaskTab}
            options={taskTabs.map((t) => ({
              ...t,
              count: countTab(
                t.value,
                tasks.map((x) => x.task)
              ),
            }))}
          />
        }
      >
        <div className='px-2 pb-3'>
          {taskLists.map((q, i) => (
            <LoadError
              key={i}
              query={q}
              prefix={multi ? machineName(i) : undefined}
            />
          ))}
          <TaskFeed
            tasks={tasks.map((x) => x.task)}
            tab={taskTab}
            showBusiness={!businessId}
            businessOf={(t) =>
              businessesOf(origin.get(t) ?? 0).find(
                (b) => b.id === t.businessId
              )
            }
            machineOf={
              multi ? (t) => machineName(origin.get(t) ?? 0) : undefined
            }
          />
        </div>
      </Panel>
    </Page>
  )
}

type Opened = { node: TopologyNode; machine: string | null }

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
  const via = new Set(nodes.filter((n) => keep.has(n.id)).map((n) => n.via))
  return nodes.filter(
    (n) =>
      keep.has(n.id) ||
      n.kind === 'business' ||
      n.kind === 'project' ||
      (n.kind === 'grok' && via.has(n.id))
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
      {prefix && `${prefix}：`}读取失败：{query.error.message}
    </p>
  )
}

/**
 * 没经派单、在 Orca 里直接开的 Agent：按所在目录挂到对应那一行的 Leader Agent 下；
 * 哪一行都对不上的项目单独成一行（只有直线、没有 Leader Agent），这些 Agent 挂在下面。
 */
function orcaNodes(
  terminals: OrcaTerminal[],
  rows: TopologyNode[]
): TopologyNode[] {
  const inside = (path: string, root?: string) =>
    !!root && (path === root || path.startsWith(root + '/'))
  const extra = new Map<string, OrcaTerminal[]>()
  const nodes: TopologyNode[] = []
  for (const t of terminals) {
    if (!t.agent) continue
    // 落在多个项目目录里时归最深的那个
    const row = rows
      .filter((n) => inside(t.project, n.project))
      .sort((a, b) => (b.project?.length ?? 0) - (a.project?.length ?? 0))[0]
    if (row) nodes.push(orcaWorker(t, row.id))
    else extra.set(t.project, [...(extra.get(t.project) ?? []), t])
  }
  for (const [project, list] of extra) {
    const root = `dir:${project}`
    const id = `dir-leader:${project}`
    const label = project.split('/').pop() ?? project
    nodes.push(
      { id: root, kind: 'business', project, label, unregistered: true },
      {
        id,
        kind: 'leader',
        parentId: root,
        project,
        label,
        activity: `${list.length} 个 Agent 在跑`,
      },
      ...list.map((t) => orcaWorker(t, id))
    )
  }
  return nodes
}

function orcaWorker(t: OrcaTerminal, parentId: string): TopologyNode {
  return {
    id: `orca:${t.handle}`,
    kind: 'worker',
    parentId,
    label: t.agent!,
    agent: t.agent!,
    liveness: 'live',
    // 终端标题前面常带 Agent 自己画的转圈 / 星号，去掉
    activity: t.title?.replace(/^[\u2800-\u28ff✳✻✽✶✢·*]+\s*/u, '') || '终端',
    sublabel: '没经派单',
    terminal: t.handle,
    startedAt: t.startedAt,
    state:
      t.status === 'working'
        ? 'working'
        : t.status === 'permission'
          ? 'blocked'
          : 'idle',
  }
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

/** 分段切换：几个状态就几栏，当前栏是实心的。 */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; count: number }[]
}) {
  return (
    <div className='flex rounded-md bg-muted p-0.5'>
      {options.map((o) => (
        <button
          key={o.value}
          type='button'
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-6 items-center gap-1.5 rounded-[5px] px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
            o.value === value && 'bg-panel text-foreground shadow-sm'
          )}
        >
          {o.label}
          <span className='font-mono text-[10px] text-muted-foreground'>
            {o.count}
          </span>
        </button>
      ))}
    </div>
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
