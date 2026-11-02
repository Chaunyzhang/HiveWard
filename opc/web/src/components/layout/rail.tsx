import { useState } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import type { BusinessSummary } from '@shared/api'
import {
  FolderOpen,
  Globe,
  History,
  Inbox,
  Laptop,
  LayoutDashboard,
  Plus,
  Settings,
  SquareTerminal,
} from 'lucide-react'
import { useOverview } from '@/lib/opc-api'
import { terminalStatus, type AgentStatus } from '@/lib/opc-format'
import { useOrcaTerminals } from '@/lib/orca-live'
import { projectForPath } from '@/lib/project-for-path'
import { cn } from '@/lib/utils'
import { ProjectLogo } from '@/components/opc/project-logo'
import { StatusDot } from '@/components/opc/status-dot'
import { AddBusinessDialog } from '@/features/businesses/add-business-dialog'
import { useDecisionsDrawer } from '@/features/decisions/drawer-context'

/**
 * 侧栏（常驻 232px）：驾驶舱、待办和几个全局页面在上面，下面是业务列表——
 * 点进去是业务页（项目、架构、终端）。「业务」旁边的 + 加业务。
 */
export function Rail() {
  const pathname = useLocation({ select: (l) => l.pathname })
  const { setOpen } = useDecisionsDrawer()
  const { data } = useOverview()
  const [adding, setAdding] = useState(false)
  const pending = data?.decisionsPending ?? 0
  const projects = (data?.businesses ?? []).filter(
    (b) => b.status !== 'archived'
  )
  // 每个项目里终端的实况：有 Agent 在干活就亮蓝点，有 Agent 等你确认就亮橙点
  const { data: terminals } = useOrcaTerminals()
  const live = new Map<string, AgentStatus[]>()
  for (const t of terminals ?? []) {
    const p = t.agent && projectForPath(projects, t.project)
    if (p) {
      live.set(p.id, [...(live.get(p.id) ?? []), terminalStatus(t.status)])
    }
  }

  return (
    <nav className='flex w-58 shrink-0 flex-col border-e bg-background py-3'>
      <Item
        to='/'
        icon={<LayoutDashboard />}
        label='驾驶舱'
        active={pathname === '/'}
      />
      <Item
        icon={<Inbox />}
        label='待办'
        onClick={() => setOpen(true)}
        trailing={pending > 0 ? String(pending) : undefined}
      />
      <Item
        to='/browser'
        icon={<Globe />}
        label='浏览器'
        active={pathname.startsWith('/browser')}
      />
      <Item
        to='/machines'
        icon={<Laptop />}
        label='局域网'
        active={pathname.startsWith('/machines')}
      />
      <Item
        to='/files'
        icon={<FolderOpen />}
        label='文件'
        active={pathname.startsWith('/files')}
      />
      <Item
        to='/live'
        icon={<SquareTerminal />}
        label='现场'
        active={pathname.startsWith('/live')}
      />
      <Item
        to='/timeline'
        icon={<History />}
        label='时间线'
        active={pathname.startsWith('/timeline')}
      />

      <div className='mx-3 mt-5 mb-1 flex h-6 items-center ps-2.5'>
        <span className='text-[11px] text-muted-foreground'>业务</span>
        <button
          type='button'
          title='加业务'
          aria-label='加业务'
          onClick={() => setAdding(true)}
          className='ms-auto grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
        >
          <Plus className='size-3.5' />
        </button>
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        {projects.map((b) => (
          <ProjectItem
            key={b.id}
            project={b}
            agents={live.get(b.id) ?? []}
            active={pathname === `/b/${b.id}`}
          />
        ))}
        {data && projects.length === 0 && (
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
    </nav>
  )
}

function ProjectItem({
  project: b,
  agents,
  active,
}: {
  project: BusinessSummary
  /** 这个项目里各个 Agent 终端的实况 */
  agents: AgentStatus[]
  active: boolean
}) {
  const waiting = b.counts.decisionsPending
  const status: AgentStatus | undefined =
    b.leader?.liveness === 'unverifiable'
      ? 'failed'
      : waiting > 0 || agents.includes('waiting')
        ? 'waiting'
        : agents.includes('working')
          ? 'working'
          : undefined
  return (
    <Item
      to={`/b/${b.id}`}
      icon={<ProjectLogo project={b} />}
      label={b.name}
      title={b.missing ? `目录不在了：${b.workspacePath}` : b.workspacePath}
      active={active}
      muted={b.status === 'paused' || b.missing}
      trailing={waiting > 0 ? String(waiting) : undefined}
      dot={status}
    />
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
    'mx-2 flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0',
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
