import { useEffect, useState } from 'react'
import { Link, useLocation, useSearch } from '@tanstack/react-router'
import type { BusinessSummary, Project } from '@shared/api'
import {
  ChevronDown,
  History,
  Inbox,
  Laptop,
  LayoutDashboard,
  Plus,
  Settings,
} from 'lucide-react'
import { useWorkspace } from '@/stores/workspace'
import { useOverview } from '@/lib/opc-api'
import { terminalStatus, type AgentStatus } from '@/lib/opc-format'
import { useOrcaTerminals } from '@/lib/orca-live'
import { insidePath, projectForPath } from '@/lib/project-for-path'
import { cn } from '@/lib/utils'
import { ProjectLogo } from '@/components/opc/project-logo'
import { StatusDot } from '@/components/opc/status-dot'
import { AddBusinessDialog } from '@/features/businesses/add-business-dialog'
import { useDecisionsDrawer } from '@/features/decisions/drawer-context'
import { NewProjectDialog } from '@/features/workbench/projects-panel'

/**
 * 左栏（常驻 232px）分两块：
 * - 集团：总览、待办、时间线、局域网——看整个集团的；
 * - 业务：标题点了整块收起 / 展开，右边 + 加业务。每块业务名后面的小三角展开它的项目，
 *   项目缩进挂在下面；悬停业务时最右边出 +，新建项目。选中只用底色，不画框。
 *   点业务看整块业务的主页，点项目看这个项目的主页；有 Agent 在干活亮蓝点，等你确认亮橙点。
 */
export function Rail() {
  const pathname = useLocation({ select: (l) => l.pathname })
  const search: { project?: string } = useSearch({ strict: false })
  const { setOpen } = useDecisionsDrawer()
  const { data } = useOverview()
  const [adding, setAdding] = useState(false)
  const [newProjectIn, setNewProjectIn] = useState<BusinessSummary | null>(null)
  const closed = useWorkspace((s) => s.businessesClosed)
  const toggleBusinesses = useWorkspace((s) => s.toggleBusinesses)
  const pending = data?.decisionsPending ?? 0
  const businesses = (data?.businesses ?? []).filter(
    (b) => b.status !== 'archived'
  )
  // 终端的实况按业务归拢：每个终端的目录落在哪块业务里
  const { data: terminals } = useOrcaTerminals()
  const live = new Map<string, { path: string; status: AgentStatus }[]>()
  for (const t of terminals ?? []) {
    const b = t.agent && projectForPath(businesses, t.project)
    if (b) {
      live.set(b.id, [
        ...(live.get(b.id) ?? []),
        { path: t.project, status: terminalStatus(t.status) },
      ])
    }
  }
  const current = pathname.startsWith('/b/') ? pathname.slice(3) : null

  return (
    <nav className='flex w-58 shrink-0 flex-col border-e bg-background py-3'>
      <Heading>集团</Heading>
      <Item
        to='/'
        icon={<LayoutDashboard />}
        label='总览'
        active={pathname === '/'}
      />
      <Item
        icon={<Inbox />}
        label='待办'
        onClick={() => setOpen(true)}
        trailing={pending > 0 ? String(pending) : undefined}
      />
      <Item
        to='/timeline'
        icon={<History />}
        label='时间线'
        active={pathname.startsWith('/timeline')}
      />
      <Item
        to='/machines'
        icon={<Laptop />}
        label='局域网'
        active={pathname.startsWith('/machines')}
      />

      <Heading>
        <button
          type='button'
          aria-expanded={!closed}
          onClick={toggleBusinesses}
          className='flex items-center gap-1 hover:text-foreground'
        >
          业务
          <ChevronDown
            className={cn(
              'size-3 transition-transform',
              closed && '-rotate-90'
            )}
          />
        </button>
        <button
          type='button'
          title='加业务'
          aria-label='加业务'
          onClick={() => setAdding(true)}
          className='ms-auto grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
        >
          <Plus className='size-3.5' />
        </button>
      </Heading>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        {!closed &&
          businesses.map((b) => (
            <BusinessItem
              key={b.id}
              business={b}
              agents={live.get(b.id) ?? []}
              current={current === b.id}
              project={current === b.id ? search.project : undefined}
              onNewProject={() => setNewProjectIn(b)}
            />
          ))}
        {!closed && data && businesses.length === 0 && (
          <button
            type='button'
            onClick={() => setAdding(true)}
            className='mx-2 mt-1 w-[calc(100%-1rem)] rounded-md border border-dashed px-3 py-2 text-start text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
          >
            加第一块业务：选一个目录
          </button>
        )}
      </div>

      <div className='mx-3 my-2 h-px bg-border' />
      <Item
        to='/settings'
        icon={<Settings />}
        label='设置'
        active={pathname.startsWith('/settings')}
      />
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

/** 一组终端的实况合成一个点：有人等你 → 橙；有人在干活 → 蓝 */
function liveDot(list: { status: AgentStatus }[]): AgentStatus | undefined {
  const s = list.map((a) => a.status)
  return s.includes('waiting')
    ? 'waiting'
    : s.includes('working')
      ? 'working'
      : undefined
}

function BusinessItem({
  business: b,
  agents,
  current,
  project,
  onNewProject,
}: {
  business: BusinessSummary
  /** 这块业务里各个 Agent 终端的目录和实况 */
  agents: { path: string; status: AgentStatus }[]
  /** 正在看这块业务（或它的某个项目） */
  current: boolean
  /** 正在看的项目 */
  project?: string
  onNewProject: () => void
}) {
  const open = useWorkspace((s) => !!s.expanded[b.id])
  const toggle = useWorkspace((s) => s.toggleExpanded)
  const lines = (b.projects ?? []).filter((p) => p.status === 'active')
  // 进了这块业务就把它展开
  useEffect(() => {
    if (current && lines.length > 0) {
      toggle(b.id, true)
    }
  }, [current, lines.length, b.id, toggle])

  const waiting = b.counts.decisionsPending
  const status: AgentStatus | undefined =
    b.leader?.liveness === 'unverifiable'
      ? 'failed'
      : waiting > 0
        ? 'waiting'
        : liveDot(agents)
  const active = current && !project
  return (
    <div>
      {/* 整行是链接（垫在下面），小三角和 + 是浮在上面的按钮 */}
      <div
        className={cn(
          'group relative mx-2 flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground has-[a:focus-visible]:bg-accent',
          active && 'bg-accent text-foreground',
          (b.status === 'paused' || b.missing) && 'opacity-60'
        )}
      >
        <Link
          to='/b/$businessId'
          params={{ businessId: b.id }}
          title={b.missing ? `目录不在了：${b.workspacePath}` : b.workspacePath}
          aria-label={b.name}
          className='absolute inset-0 rounded-md outline-none'
        />
        <span className='pointer-events-none flex size-[18px] shrink-0 items-center justify-center'>
          <ProjectLogo project={b} />
        </span>
        <span className='pointer-events-none min-w-0 truncate'>{b.name}</span>
        {lines.length > 0 && (
          <button
            type='button'
            aria-label={open ? '收起项目' : '展开项目'}
            aria-expanded={open}
            onClick={() => toggle(b.id)}
            className='relative -ms-1.5 grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground'
          >
            <ChevronDown
              className={cn(
                'size-3 transition-transform',
                !open && '-rotate-90'
              )}
            />
          </button>
        )}
        {status && (
          <StatusDot status={status} className='pointer-events-none' />
        )}
        {waiting > 0 && (
          <span className='pointer-events-none ms-auto font-mono text-[11px] text-attention group-hover:hidden'>
            {waiting}
          </span>
        )}
        <button
          type='button'
          title='新建项目'
          aria-label={`在「${b.name}」里新建项目`}
          onClick={onNewProject}
          className='relative ms-auto hidden size-6 shrink-0 place-items-center rounded-md text-muted-foreground group-hover:grid hover:bg-background hover:text-foreground'
        >
          <Plus className='size-3.5' />
        </button>
      </div>
      {open && lines.length > 0 && (
        <ul>
          {lines.map((p) => (
            <ProjectItem
              key={p.id}
              project={p}
              status={liveDot(agents.filter((a) => insidePath(a.path, p.path)))}
              active={current && project === p.id}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

/** 业务下的一个项目：缩进到和业务名对齐，不画连线 */
function ProjectItem({
  project: p,
  status,
  active,
}: {
  project: Project
  status?: AgentStatus
  active: boolean
}) {
  return (
    <li>
      <Link
        to='/b/$businessId'
        params={{ businessId: p.businessId }}
        search={{ project: p.id }}
        title={p.path}
        className={cn(
          'mx-2 flex h-8 items-center gap-2 rounded-md ps-[38px] pe-2.5 text-[13px] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent',
          active && 'bg-accent text-foreground'
        )}
      >
        <span className='min-w-0 truncate'>{p.name}</span>
        {status && <StatusDot status={status} />}
      </Link>
    </li>
  )
}

function Item({
  to,
  onClick,
  icon,
  label,
  title,
  active,
  muted,
  dot,
  trailing,
}: {
  to?: string
  onClick?: () => void
  icon: React.ReactNode
  label: string
  /** 悬停提示 */
  title?: string
  active?: boolean
  muted?: boolean
  /** 名字后面的状态圆点：故障红、等你处理橙、有 Agent 在干活蓝 */
  dot?: AgentStatus
  trailing?: string
}) {
  const cls = cn(
    'mx-2 flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent [&_svg]:size-4 [&_svg]:shrink-0',
    active && 'bg-accent text-foreground',
    muted && 'opacity-60'
  )
  const content = (
    <>
      <span className='flex size-[18px] shrink-0 items-center justify-center'>
        {icon}
      </span>
      <span className='min-w-0 truncate'>{label}</span>
      {dot && <StatusDot status={dot} />}
      {trailing && (
        <span className='ms-auto font-mono text-[11px] text-attention'>
          {trailing}
        </span>
      )}
    </>
  )
  if (to) {
    return (
      <Link to={to} title={title} className={cls}>
        {content}
      </Link>
    )
  }
  return (
    <button type='button' title={title} onClick={onClick} className={cls}>
      {content}
    </button>
  )
}
