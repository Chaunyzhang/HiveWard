import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import type { ObjectiveStatus } from '@shared/api'
import {
  ChevronsUpDown,
  Laptop,
  PanelRight,
  Search as SearchIcon,
} from 'lucide-react'
import { useWorkspace } from '@/stores/workspace'
import {
  useCurrentMachine,
  useMachineGuard,
  useMachines,
  useSwitchMachine,
} from '@/lib/machine'
import { useBusinessDetail, useOverview } from '@/lib/opc-api'
import { cn } from '@/lib/utils'
import { useSearch as useCommandSearch } from '@/context/search-provider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { HiveLogo } from '@/components/opc/hive-logo'
import { ThemeSwitch } from '@/components/theme-switch'
import { useSideScope } from './side-panel'
import { StatusPill } from './status-pill'

/** 面包屑：HiveWard / 电脑（有配对的电脑时才出现）/ 项目（可切换）/ 目标 = Orca Run（可切换），同 Supabase 的 组织/项目/分支。 */
export function TopBar() {
  const { setOpen } = useCommandSearch()
  useMachineGuard()
  return (
    <header className='app-top-bar flex h-12 shrink-0 items-center gap-3 border-b px-3'>
      <Link
        to='/'
        className='flex size-8 items-center justify-center'
        aria-label='HiveWard 总览'
      >
        <HiveLogo className='size-6' />
      </Link>
      <Slash />
      <Link to='/' className='text-sm font-medium hover:text-foreground'>
        HiveWard
      </Link>
      <MachineCrumb />
      <BusinessCrumbs />

      <div className='ms-auto flex items-center gap-2'>
        <StatusPill />
        <button
          type='button'
          onClick={() => setOpen(true)}
          className='flex h-8 w-56 items-center gap-2 rounded-full bg-accent/60 px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
        >
          <SearchIcon className='size-4' />
          <span>搜索…</span>
          <kbd className='ms-auto font-mono text-xs'>
            {navigator.userAgent.includes('Mac') ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
        <ThemeSwitch />
        <SideToggle />
      </div>
    </header>
  )
}

/** 开关右栏（文件 / 浏览器） */
function SideToggle() {
  const open = useWorkspace((s) => s.sideOpen)
  const setOpen = useWorkspace((s) => s.setSideOpen)
  const { root, agent } = useSideScope()
  // 集团页面右栏没东西可看，不出现
  if (!root && !agent) {
    return null
  }
  return (
    <button
      type='button'
      title={open ? '收起右栏' : '打开右栏：文件 / 浏览器'}
      aria-label={open ? '收起右栏' : '打开右栏'}
      aria-pressed={open}
      onClick={() => setOpen(!open)}
      className={cn(
        'grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground',
        open && 'text-foreground'
      )}
    >
      <PanelRight className='size-4' />
    </button>
  )
}

/** 正在看哪台电脑。切到别的电脑时高亮，免得以为看的是本机 */
function MachineCrumb() {
  const { data } = useMachines()
  const current = useCurrentMachine()
  const switchTo = useSwitchMachine()
  const navigate = useNavigate()
  const machines = (data ?? []).filter((m) => m.self || m.paired)
  if (!current || machines.length < 2) return null
  const remote = !current.self

  return (
    <>
      <Slash />
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            crumb,
            remote &&
              'bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand'
          )}
        >
          <Laptop className='size-3.5' />
          <span className={cn(!remote && 'text-foreground')}>
            {current.name}
          </span>
          <ChevronsUpDown className='size-3.5 opacity-60' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='w-60'>
          <DropdownMenuLabel className='mono-label'>电脑</DropdownMenuLabel>
          {machines.map((m) => (
            <DropdownMenuItem
              key={m.id}
              disabled={!m.self && m.status !== 'online'}
              onClick={async () => {
                await switchTo(m)
                navigate({ to: '/' })
              }}
              className={cn(m.id === current.id && 'bg-accent')}
            >
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  m.status === 'online' ? 'bg-live' : 'bg-muted-foreground/40'
                )}
              />
              <span className='truncate'>{m.name}</span>
              {m.self && (
                <span className='ms-auto text-xs text-muted-foreground'>
                  本机
                </span>
              )}
              {!m.self && m.summary && m.summary.decisionsPending > 0 && (
                <span className='ms-auto size-1.5 rounded-full bg-attention' />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate({ to: '/machines' })}>
            管理局域网…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

function BusinessCrumbs() {
  const params = useParams({ strict: false })
  const businessId = params.businessId
  const { data: overview } = useOverview()
  const navigate = useNavigate()
  const businesses = (overview?.businesses ?? []).filter(
    (b) => b.status !== 'archived'
  )
  const current = businesses.find((b) => b.id === businessId)

  return (
    <>
      <Slash />
      <DropdownMenu>
        <DropdownMenuTrigger className={crumb}>
          {current ? (
            <>
              <span>{current.icon}</span>
              <span className='text-foreground'>{current.name}</span>
            </>
          ) : (
            <span>全部业务</span>
          )}
          <ChevronsUpDown className='size-3.5 opacity-60' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='w-56'>
          <DropdownMenuItem onClick={() => navigate({ to: '/' })}>
            全部业务
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className='mono-label'>业务</DropdownMenuLabel>
          {businesses.map((b) => (
            <DropdownMenuItem
              key={b.id}
              onClick={() =>
                navigate({ to: '/b/$businessId', params: { businessId: b.id } })
              }
              className={cn(b.id === businessId && 'bg-accent')}
            >
              <span>{b.icon}</span>
              {b.name}
              {b.counts.decisionsPending > 0 && (
                <span className='ms-auto size-1.5 rounded-full bg-attention' />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {businessId && <ObjectiveCrumb businessId={businessId} />}
    </>
  )
}

const objectiveTone: Record<ObjectiveStatus, string> = {
  draft: 'text-muted-foreground border-border',
  sent: 'text-muted-foreground border-border',
  running: 'text-brand border-brand/40 bg-brand/10',
  done: 'text-muted-foreground border-border',
  failed: 'text-danger border-danger/40 bg-danger/10',
}

const objectiveLabel: Record<ObjectiveStatus, string> = {
  draft: 'DRAFT',
  sent: 'SENT',
  running: 'RUNNING',
  done: 'DONE',
  failed: 'FAILED',
}

function ObjectiveCrumb({ businessId }: { businessId: string }) {
  const { data } = useBusinessDetail(businessId)
  const search = useSearch({ strict: false }) as { objective?: string }
  const navigate = useNavigate()
  const objectives = data?.objectives ?? []
  if (objectives.length === 0) return null
  const current =
    objectives.find((o) => o.id === search.objective) ?? objectives[0]

  return (
    <>
      <Slash />
      <DropdownMenu>
        <DropdownMenuTrigger className={crumb}>
          <span className='max-w-48 truncate text-foreground'>
            {current.title}
          </span>
          <ObjectiveBadge status={current.status} />
          <ChevronsUpDown className='size-3.5 opacity-60' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='w-72'>
          <DropdownMenuLabel className='mono-label'>目标</DropdownMenuLabel>
          {objectives.map((o) => (
            <DropdownMenuItem
              key={o.id}
              onClick={() =>
                navigate({
                  to: '/b/$businessId',
                  params: { businessId },
                  search: { objective: o.id },
                })
              }
              className={cn(o.id === current.id && 'bg-accent')}
            >
              <span className='truncate'>{o.title}</span>
              <span className='ms-auto font-mono text-xs text-muted-foreground'>
                {o.progress.done}/{o.progress.total}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

export function ObjectiveBadge({ status }: { status: ObjectiveStatus }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-px font-mono text-[10px] tracking-wider',
        objectiveTone[status]
      )}
    >
      {objectiveLabel[status]}
    </span>
  )
}

const crumb =
  'flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground'

function Slash() {
  return <span className='text-border select-none'>/</span>
}
