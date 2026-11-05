import { useEffect, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import {
  Link,
  useLocation,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import type { BusinessSummary, Machine, TopologyNode } from '@shared/api'
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Laptop,
  ListChecks,
  Network,
  Plus,
  Settings,
} from 'lucide-react'
import { useWorkspace } from '@/stores/workspace'
import { overviewQuery, topologyQuery } from '@/lib/hiveward-api'
import {
  backgroundNote,
  errorStopText,
  terminalTitle,
  type AgentStatus,
} from '@/lib/hiveward-format'
import { terminalsQuery, useQuota } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import {
  MachineScope,
  useCurrentMachineId,
  useFleet,
  useSwitchMachine,
} from '@/lib/machine'
import { cn } from '@/lib/utils'
import { AgentLogo } from '@/components/hiveward/agent-logo'
import { ExternalTag, SeatTag } from '@/components/hiveward/external-tag'
import { ProjectLogo } from '@/components/hiveward/project-logo'
import { StatusDot } from '@/components/hiveward/status-dot'
import { AddBusinessDialog } from '@/features/businesses/add-business-dialog'
import { externalOrigin } from '@/features/session/external-seat'
import {
  offlineNote,
  remoteLabel,
  useRemoteSeat,
} from '@/features/session/remote-seat'
import {
  allRows,
  buildSessionTree,
  groupStatus,
  sessionLabel,
  type BusinessTree,
  type ProjectGroup,
  type SessionRow,
} from '@/features/session/session-tree'
import {
  useAirborneOnline,
  useOpenAirborne,
} from '@/features/session/use-open-airborne'
import { CloseWorkerButton } from '@/features/session/worker-close'
import { useSettings } from '@/features/settings'
import { NewProjectDialog } from '@/features/workbench/projects-panel'
import { WindowControls } from './top-bar'

type RailSearch = { project?: string; session?: string; m?: string }

/** 中间栏正在看的会话：打开的会话（?session=），或「现场」里选中的终端；左栏对应那一行显示选中 */
type RailFocus = { nodeId?: string; handle?: string; machine: string | null }

// 按终端认时不认外援那一行：外援在自己业务下的那行才是它本人
const focusing = (n: TopologyNode, machine: string | null, f: RailFocus) =>
  f.machine === machine &&
  (n.id === f.nodeId || (!!f.handle && n.terminal === f.handle && !n.external))

/**
 * 左栏（会话栏，像 Claude 桌面端的会话列表）：
 * - 集团：架构图（首页）、任务、局域网；
 * - 业务：一块业务一组，下面先是常驻的 CEO、Personal Agent，再是各个项目；项目下面是它的会话
 *   （Leader 和派出去的下属）。组前面的小三角展开 / 收起，组里的条目用竖的大纲线连起来；
 *   标题右边「全部收起 / 全部展开」和加业务。
 * 点业务、项目进它的主页；点会话在中间栏打开它的对话。选中只用底色。
 * 多台电脑时每台一段，标明是哪台。
 */
export function Rail() {
  const open = useWorkspace((s) => s.railOpen)
  const showSettings = useSettings((s) => s.show)
  const pathname = useLocation({ select: (l) => l.pathname })
  const search: RailSearch = useSearch({ strict: false })
  const [adding, setAdding] = useState(false)
  const [newProjectIn, setNewProjectIn] = useState<BusinessSummary | null>(null)
  const closed = useWorkspace((s) => s.businessesClosed)
  const toggleBusinesses = useWorkspace((s) => s.toggleBusinesses)
  const expanded = useWorkspace((s) => s.expanded)
  const setAllExpanded = useWorkspace((s) => s.setAllExpanded)
  const session = useWorkspace((s) => s.session)
  const agent = useWorkspace((s) => s.agent)
  const viewing = useCurrentMachineId()
  // 打开的会话按节点认；架构图上没有、按终端现拼的（hiveward:handle）才按终端认；远程下属按本机那张卡认
  const focus: RailFocus = session?.via
    ? session.via
    : session
      ? {
          nodeId: session.nodeId,
          handle: session.nodeId.startsWith('hiveward:')
            ? session.handle
            : undefined,
          machine: session.machine,
        }
      : { handle: agent ?? undefined, machine: viewing }

  const fleet = useFleet()
  const ids = fleet.map((f) => f.id)
  const overviews = useQueries({ queries: ids.map(overviewQuery) })
  const topologies = useQueries({
    queries: ids.map((m) => topologyQuery(m)),
  })
  const terminals = useQueries({ queries: ids.map(terminalsQuery) })
  const sections = fleet.map((f, i) => {
    const prefix = f.id ? `${f.id}:` : ''
    return {
      ...f,
      prefix,
      loaded: !!overviews[i].data,
      trees: buildSessionTree(
        overviews[i].data?.businesses ?? [],
        topologies[i].data?.nodes ?? [],
        terminals[i].data,
        prefix,
        fleet.flatMap((x) => {
          const id = x !== f && (x.machine?.id ?? x.id)
          return id ? [id] : []
        })
      ),
    }
  })
  const keys = {
    businesses: sections.flatMap((s) =>
      s.trees.map((t) => s.prefix + t.business.id)
    ),
    projects: sections.flatMap((s) =>
      s.trees.flatMap((t) => t.projects.map((p) => p.key))
    ),
  }
  const anyOpen = keys.businesses.some((k) => expanded[k])
  const empty = sections.every((s) => s.loaded && s.trees.length === 0)

  if (!open) {
    return null
  }
  return (
    <nav
      aria-label={tr('会话栏')}
      className='flex w-64 shrink-0 flex-col border-e bg-background pb-3'
    >
      <div className='app-top-bar app-top-left mb-2 flex h-12 shrink-0 items-center border-b px-3'>
        <WindowControls />
      </div>
      <Heading>{tr('集团')}</Heading>
      <Item
        to='/'
        icon={<Network />}
        label={tr('架构图')}
        active={pathname === '/' && !search.session}
      />
      <Item
        to='/tasks'
        icon={<ListChecks />}
        label={tr('任务')}
        active={pathname.startsWith('/tasks')}
      />
      <Item
        to='/machines'
        icon={<Laptop />}
        label={tr('局域网')}
        active={pathname.startsWith('/machines')}
      />

      <Heading>
        <button
          type='button'
          aria-expanded={!closed}
          onClick={toggleBusinesses}
          className='flex items-center gap-1 hover:text-foreground'
        >
          {tr('业务')}
          <ChevronRight
            className={cn(
              'size-3 transition-transform',
              !closed && 'rotate-90'
            )}
          />
        </button>
        <span className='ms-auto flex items-center'>
          {!closed && keys.businesses.length > 0 && (
            <HeadingButton
              label={anyOpen ? tr('全部收起') : tr('全部展开')}
              onClick={() => setAllExpanded(!anyOpen, keys)}
            >
              {anyOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
            </HeadingButton>
          )}
          <HeadingButton label={tr('加业务')} onClick={() => setAdding(true)}>
            <Plus />
          </HeadingButton>
        </span>
      </Heading>
      <div className='min-h-0 flex-1 overflow-y-auto pb-2'>
        {!closed &&
          sections.map((s) => (
            <MachineScope key={s.id ?? 'self'} id={s.id}>
              {sections.length > 1 && <MachineLabel machine={s.machine} />}
              {s.trees.map((t) => (
                <BusinessGroup
                  key={t.business.id}
                  tree={t}
                  machine={s.id}
                  remote={!!s.id}
                  machineRecord={s.machine}
                  openKey={s.prefix + t.business.id}
                  pathname={pathname}
                  search={search}
                  focus={focus}
                  onNewProject={() => setNewProjectIn(t.business)}
                />
              ))}
            </MachineScope>
          ))}
        {!closed && empty && (
          <button
            type='button'
            onClick={() => setAdding(true)}
            className='mx-2 mt-1 w-[calc(100%-1rem)] rounded-md border border-dashed px-3 py-2 text-start text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
          >
            {tr('加第一块业务：选一个目录')}
          </button>
        )}
      </div>

      <div className='mx-3 my-2 h-px bg-border' />
      <button
        type='button'
        onClick={() => showSettings()}
        className='mx-2 flex h-8 items-center gap-2.5 rounded-md px-2.5 text-start text-[13px] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent [&_svg]:size-4 [&_svg]:shrink-0'
      >
        <span className='flex size-[18px] shrink-0 items-center justify-center'>
          <Settings />
        </span>
        <span className='min-w-0 truncate'>{tr('设置')}</span>
      </button>
      <AddBusinessDialog open={adding} onOpenChange={setAdding} />
      {newProjectIn && (
        <NewProjectDialog
          open
          business={newProjectIn}
          onClose={() => setNewProjectIn(null)}
        />
      )}
    </nav>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div className='mx-3 mt-4 mb-1 flex h-6 items-center ps-2.5 text-[11px] text-muted-foreground first:mt-0'>
      {children}
    </div>
  )
}

function HeadingButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      title={label}
      aria-label={label}
      onClick={onClick}
      className='grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5'
    >
      {children}
    </button>
  )
}

function MachineLabel({ machine }: { machine?: Machine }) {
  return (
    <div className='mx-3 mt-2 mb-0.5 flex h-6 items-center gap-1.5 ps-2.5 text-[11px] text-muted-foreground'>
      <Laptop className='size-3' />
      <span className='truncate'>{machine?.name ?? tr('本机')}</span>
      {machine?.self && <span className='opacity-70'>{tr('· 本机')}</span>}
    </div>
  )
}

/** 一行的外壳：整行是链接或按钮（垫在下面），小三角和 + 是浮在上面的按钮 */
const rowClass = (active: boolean) =>
  cn(
    'group relative flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground has-[a:focus-visible]:bg-accent has-[button[data-row]:focus-visible]:bg-accent',
    active && 'bg-accent text-foreground'
  )

/** 展开 / 收起的小三角；没有子项时占个位，名字照样对齐 */
function Twisty({
  open,
  label,
  onToggle,
}: {
  open: boolean
  label: string
  onToggle?: () => void
}) {
  if (!onToggle) {
    return <span className='size-4 shrink-0' />
  }
  return (
    <button
      type='button'
      aria-label={
        open ? tr('收起「{0}」', [label]) : tr('展开「{0}」', [label])
      }
      aria-expanded={open}
      onClick={onToggle}
      className='relative z-10 -mx-0.5 grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground'
    >
      <ChevronRight
        className={cn('size-3.5 transition-transform', open && 'rotate-90')}
      />
    </button>
  )
}

/** 组里的条目：左边一条竖的大纲线，从父级的小三角下面垂下来 */
function Outline({ children }: { children: React.ReactNode }) {
  return (
    <ul className='relative ms-[17px] border-s border-border/80 ps-1.5'>
      {children}
    </ul>
  )
}

function BusinessGroup({
  tree,
  machine,
  remote,
  machineRecord,
  openKey,
  pathname,
  search,
  focus,
  onNewProject,
}: {
  tree: BusinessTree
  machine: string | null
  /** 别的电脑上的业务：点业务、项目先切过去 */
  remote: boolean
  machineRecord?: Machine
  openKey: string
  pathname: string
  search: RailSearch
  focus: RailFocus
  onNewProject: () => void
}) {
  const b = tree.business
  const open = useWorkspace((s) => !!s.expanded[openKey])
  const toggle = useWorkspace((s) => s.toggleExpanded)
  const setAllExpanded = useWorkspace((s) => s.setAllExpanded)
  const switchTo = useSwitchMachine()
  const navigate = useNavigate()
  const here =
    pathname === `/b/${encodeURIComponent(b.id)}` || pathname === `/b/${b.id}`
  const sameMachine = (search.m ?? null) === machine
  const current = here && (remote ? sameMachine : !search.m)
  // 进了这块业务就把它展开
  useEffect(() => {
    if (current) {
      toggle(openKey, true)
    }
  }, [current, openKey, toggle])

  const sessions = allRows([
    tree.ceo,
    tree.grok,
    ...tree.projects.flatMap((p) => p.sessions),
  ])
  // 中间栏看的会话在这块业务里：展开它和它所在的项目，让选中的那一行露出来
  const focused = sessions.find((r) => focusing(r.node, machine, focus))?.node
    .id
  const focusedProject = tree.projects.find((p) =>
    allRows(p.sessions).some((r) => r.node.id === focused)
  )?.key
  useEffect(() => {
    if (focused) {
      setAllExpanded(true, {
        businesses: [openKey],
        projects: focusedProject ? [focusedProject] : [],
      })
    }
  }, [focused, focusedProject, openKey, setAllExpanded])
  const waiting = b.counts.decisionsPending
  const status: AgentStatus | undefined =
    groupStatus(sessions) ?? (waiting > 0 ? 'waiting' : undefined)
  const active = current && !search.project && !search.session && !focused
  const goHome = async (project?: string) => {
    if (remote && machineRecord) {
      await switchTo(machineRecord)
    }
    void navigate({
      to: '/b/$businessId',
      params: { businessId: b.id },
      search: { project },
    })
  }

  return (
    <div className='mx-2'>
      <div
        className={cn(
          rowClass(active),
          (b.status === 'paused' || b.missing) && 'opacity-60'
        )}
      >
        <RowTarget
          label={b.name}
          title={
            tree.foreign
              ? tr('别的电脑派过来、不属于这台电脑任何业务的活')
              : b.missing
                ? tr('目录不在了：{0}', [b.workspacePath])
                : remote
                  ? tr('{0}（在{1}上）', [
                      b.workspacePath,
                      machineRecord?.name ?? tr('那台电脑'),
                    ])
                  : b.workspacePath
          }
          link={
            remote || tree.foreign
              ? undefined
              : { to: '/b/$businessId', params: { businessId: b.id } }
          }
          // 「外来派单」没有业务页，点了只是展开收起
          onClick={
            tree.foreign
              ? () => toggle(openKey)
              : remote
                ? () => void goHome()
                : undefined
          }
        />
        <Twisty open={open} label={b.name} onToggle={() => toggle(openKey)} />
        <span className='pointer-events-none flex size-[18px] shrink-0 items-center justify-center'>
          <ProjectLogo project={b} />
        </span>
        <span className='pointer-events-none min-w-0 truncate'>{b.name}</span>
        {status && (
          <StatusDot status={status} className='pointer-events-none' />
        )}
        {waiting > 0 && (
          <span className='pointer-events-none ms-auto font-mono text-[11px] text-attention group-hover:hidden'>
            {waiting}
          </span>
        )}
        {!remote && !tree.foreign && (
          <button
            type='button'
            title={tr('新建项目')}
            aria-label={tr('在「{0}」里新建项目', [b.name])}
            onClick={onNewProject}
            className='relative z-10 ms-auto hidden size-6 shrink-0 place-items-center rounded-md text-muted-foreground group-hover:grid hover:bg-background hover:text-foreground'
          >
            <Plus className='size-3.5' />
          </button>
        )}
      </div>
      {open && (
        <Outline>
          {tree.ceo && (
            <SessionItem
              row={tree.ceo}
              business={b.id}
              machine={machine}
              focus={focus}
            />
          )}
          {tree.grok && (
            <SessionItem
              row={tree.grok}
              business={b.id}
              machine={machine}
              focus={focus}
            />
          )}
          {tree.projects.map((p) => (
            <ProjectItem
              key={p.key}
              group={p}
              business={b.id}
              machine={machine}
              focus={focus}
              active={
                current &&
                !!p.projectId &&
                search.project === p.projectId &&
                !allRows(p.sessions).some((r) => r.node.id === focused)
              }
              onOpen={
                remote && p.projectId
                  ? () => void goHome(p.projectId)
                  : undefined
              }
            />
          ))}
        </Outline>
      )}
    </div>
  )
}

/** 垫在一行下面的点击区：本机的是链接，别的电脑上的是按钮（先切过去再进） */
function RowTarget({
  label,
  title,
  link,
  onClick,
}: {
  label: string
  title?: string
  link?: {
    to: '/b/$businessId'
    params: { businessId: string }
    search?: Record<string, string | undefined>
  }
  onClick?: () => void
}) {
  const cls = 'absolute inset-0 rounded-md outline-none'
  if (link) {
    return (
      <Link
        to={link.to}
        params={link.params}
        search={link.search ?? {}}
        title={title}
        aria-label={label}
        className={cls}
      />
    )
  }
  return (
    <button
      type='button'
      data-row
      title={title}
      aria-label={label}
      onClick={onClick}
      className={cls}
    />
  )
}

function ProjectItem({
  group: p,
  business,
  machine,
  focus,
  active,
  onOpen,
}: {
  group: ProjectGroup
  business: string
  machine: string | null
  focus: RailFocus
  active: boolean
  onOpen?: () => void
}) {
  const closed = useWorkspace((s) => !!s.projectsClosed[p.key])
  const toggle = useWorkspace((s) => s.toggleProject)
  const status = groupStatus(allRows(p.sessions))
  const hasSessions = p.sessions.length > 0
  const isOnline = useAirborneOnline()
  const openAirborne = useOpenAirborne()
  const airborne = p.airborne?.info
  // 空降 Leader 的影子行：在线时点它到那台电脑上打开真正的座位；离线变淡，只能展开看下属
  const offline = !!airborne && !isOnline(airborne)
  return (
    <li>
      <div className={cn(rowClass(active), offline && 'opacity-60')}>
        {airborne ? (
          <RowTarget
            label={p.label}
            title={
              offline
                ? tr('{0} 离线', [airborne.machineName])
                : [
                    tr('到 {0} 上打开 {1}', [
                      airborne.machineName,
                      airborne.dispatcherLabel,
                    ]),
                    airborne.businessName,
                  ]
                    .filter(Boolean)
                    .join(' · ')
            }
            onClick={
              offline ? () => toggle(p.key) : () => void openAirborne(airborne)
            }
          />
        ) : p.projectId ? (
          <RowTarget
            label={p.label}
            title={p.path}
            link={
              onOpen
                ? undefined
                : {
                    to: '/b/$businessId',
                    params: { businessId: business },
                    search: { project: p.projectId },
                  }
            }
            onClick={onOpen}
          />
        ) : (
          <RowTarget
            label={p.label}
            title={tr('开在业务目录里、不属于任何项目的会话')}
            onClick={() => toggle(p.key)}
          />
        )}
        <Twisty
          open={!closed}
          label={p.label}
          onToggle={hasSessions ? () => toggle(p.key) : undefined}
        />
        {airborne && (
          <SeatTag className='pointer-events-none'>{tr('空降')}</SeatTag>
        )}
        <span
          className={cn(
            'pointer-events-none min-w-0 truncate',
            !p.projectId && !airborne && 'italic'
          )}
        >
          {p.label}
        </span>
        {status && (closed || !hasSessions) && (
          <StatusDot status={status} className='pointer-events-none' />
        )}
        {hasSessions && (
          <span className='pointer-events-none ms-auto font-mono text-[11px] text-muted-foreground/70'>
            {allRows(p.sessions).length}
          </span>
        )}
      </div>
      {!closed && hasSessions && (
        <Outline>
          {p.sessions.map((s) => (
            <SessionItem
              key={s.node.id}
              row={s}
              business={business}
              machine={machine}
              focus={focus}
            />
          ))}
        </Outline>
      )}
    </li>
  )
}

/**
 * 一个会话：Agent 的 logo、坐的位子（下属后面跟手上的活；没坐座位的只写活）、状态点；点了在中间栏打开它的对话。
 * 外援前面标「外援」、写它自己的出处。挂在它后面的下属用大纲线缩进一层，和架构图同样的层级。
 */
function SessionItem({
  row: { node: n, title, status, background, children },
  business,
  machine,
  focus,
}: {
  row: SessionRow
  business: string
  machine: string | null
  focus: RailFocus
}) {
  const active = focusing(n, machine, focus)
  const origin = externalOrigin(n)
  // 派到别的电脑上执行的、别的电脑派来的：标上电脑名
  const seats = useRemoteSeat()
  const remote = seats.execution(n)
  const place = remote ? remote.machineName : seats.from(n)
  const label = origin ?? title ?? sessionLabel(n)
  // 同一个项目下的下属职位都一样，后面浅色跟上手上的活，分得清谁是谁
  const task =
    title && n.kind === 'worker' ? terminalTitle(n.activity) : undefined
  const empty = n.kind === 'ceo' && !n.agent && !n.terminal && !n.sessionId
  const quota = useQuota().data
  const stop =
    n.errorStop &&
    (status === 'quota' || status === 'failed') &&
    errorStopText(
      n.errorStop,
      quota?.providers.find((p) => p.agent === n.agent)?.resetsAt
    )
  return (
    <li>
      <div className='group/close relative'>
        <Link
          to='/b/$businessId'
          params={{ businessId: business }}
          search={{ session: n.id, m: machine ?? undefined }}
          title={[
            title ?? label,
            n.kind === 'worker' ? task : n.sublabel,
            remote &&
              (remote.online ? remoteLabel(remote) : offlineNote(remote, n)),
            !remote && place,
            stop,
            backgroundNote(background),
          ]
            .filter(Boolean)
            .join(' · ')}
          className={cn(
            rowClass(active),
            'outline-none focus-visible:bg-accent',
            (empty || (remote && !remote.online)) && 'opacity-60'
          )}
        >
          <span className='flex size-4 shrink-0 items-center justify-center'>
            {n.agent ? (
              <AgentLogo agent={n.agent} className='size-3.5' />
            ) : (
              <span className='size-1.5 rounded-full border border-muted-foreground/50' />
            )}
          </span>
          {origin && <ExternalTag />}
          {place && <SeatTag className='max-w-20'>{place}</SeatTag>}
          <span className='min-w-0 flex-1 truncate'>
            {label}
            {task && (
              <span className='ms-1.5 text-muted-foreground/70'>{task}</span>
            )}
          </span>
          {status && !(remote && !remote.online) && (
            <StatusDot status={status} />
          )}
        </Link>
        <CloseWorkerButton
          node={n}
          hover
          className='absolute end-3 top-1 bg-accent'
        />
      </div>
      {children.length > 0 && (
        <Outline>
          {children.map((s) => (
            <SessionItem
              key={s.node.id}
              row={s}
              business={business}
              machine={machine}
              focus={focus}
            />
          ))}
        </Outline>
      )}
    </li>
  )
}

function Item({
  to,
  icon,
  label,
  active,
}: {
  to: string
  icon: React.ReactNode
  label: string
  active?: boolean
}) {
  return (
    <Link
      to={to}
      className={cn(
        'mx-2 flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent [&_svg]:size-4 [&_svg]:shrink-0',
        active && 'bg-accent text-foreground'
      )}
    >
      <span className='flex size-[18px] shrink-0 items-center justify-center'>
        {icon}
      </span>
      <span className='min-w-0 truncate'>{label}</span>
    </Link>
  )
}
