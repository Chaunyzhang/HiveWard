import {
  Link,
  useNavigate,
  useParams,
  useRouter,
  useSearch,
} from '@tanstack/react-router'
import type { ObjectiveStatus } from '@shared/api'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Laptop,
  PanelLeft,
} from 'lucide-react'
import { useWorkspace } from '@/stores/workspace'
import { useBusinessDetail, useOverview } from '@/lib/hiveward-api'
import { tr } from '@/lib/i18n'
import {
  useCurrentMachine,
  useMachineGuard,
  useMachines,
  useSwitchMachine,
} from '@/lib/machine'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { HiveLogo } from '@/components/hiveward/hive-logo'
import { SessionToolbar } from '@/features/session/session-toolbar'
import { EngineAlert } from './engine-alert'
import { IconButton } from './icon-button'
import { QuotaAlert } from './quota-alert'
import { TopBarSlot } from './top-bar-slot'

/**
 * 中间栏的顶栏，和左栏、右栏的顶行连成一排（像 Claude 桌面端）。
 * 打开会话时，中间那格是会话自己的标题行（名字、状态、对话 / 终端、工具栏），由会话挂进来；
 * 主页上是面包屑：电脑（有配对的电脑时才出现）/ 业务（可切换）/ 目标（可切换），右边是更改、文件。
 * 左栏收起时，会话栏开关和前进后退挪到这里最左边。
 */
export function TopBar() {
  useMachineGuard()
  const railOpen = useWorkspace((s) => s.railOpen)
  const session = useWorkspace((s) => s.session)
  return (
    <header
      className={cn(
        'app-top-bar flex h-12 shrink-0 items-center gap-2 border-b px-3',
        !railOpen && 'app-top-left'
      )}
    >
      {!railOpen && <WindowControls />}
      {session ? (
        <TopBarSlot className='px-1' />
      ) : (
        <div className='flex min-w-0 flex-1 items-center gap-2'>
          <MachineCrumb />
          <BusinessCrumbs />
          <SessionToolbar className='ms-auto' />
        </div>
      )}
      <QuotaAlert />
      <EngineAlert />
    </header>
  )
}

/** 左上角：HiveWard、会话栏开关、前进后退。左栏开着时在左栏顶上，收起时在顶栏最左边 */
export function WindowControls() {
  const railOpen = useWorkspace((s) => s.railOpen)
  const setRailOpen = useWorkspace((s) => s.setRailOpen)
  const router = useRouter()
  return (
    <div className='flex shrink-0 items-center gap-0.5'>
      <Link
        to='/'
        className='me-1 grid size-7 place-items-center'
        aria-label={tr('HiveWard 总览')}
        title={tr('HiveWard 总览')}
      >
        <HiveLogo className='size-5' />
      </Link>
      <IconButton
        label={railOpen ? tr('收起会话栏') : tr('展开会话栏')}
        aria-pressed={railOpen}
        onClick={() => setRailOpen(!railOpen)}
      >
        <PanelLeft />
      </IconButton>
      <IconButton label={tr('后退')} onClick={() => router.history.back()}>
        <ChevronLeft />
      </IconButton>
      <IconButton label={tr('前进')} onClick={() => router.history.forward()}>
        <ChevronRight />
      </IconButton>
    </div>
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
          <DropdownMenuLabel className='mono-label'>
            {tr('电脑')}
          </DropdownMenuLabel>
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
                  {tr('本机')}
                </span>
              )}
              {!m.self && m.summary && m.summary.decisionsPending > 0 && (
                <span className='ms-auto size-1.5 rounded-full bg-attention' />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate({ to: '/machines' })}>
            {tr('管理局域网…')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Slash />
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
      <DropdownMenu>
        <DropdownMenuTrigger className={cn(crumb, '-ms-1')}>
          {current ? (
            <>
              <span>{current.icon}</span>
              <span className='text-foreground'>{current.name}</span>
            </>
          ) : (
            <span>{tr('全部业务')}</span>
          )}
          <ChevronsUpDown className='size-3.5 opacity-60' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='w-56'>
          <DropdownMenuItem onClick={() => navigate({ to: '/' })}>
            {tr('全部业务')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className='mono-label'>
            {tr('业务')}
          </DropdownMenuLabel>
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
          <DropdownMenuLabel className='mono-label'>
            {tr('目标')}
          </DropdownMenuLabel>
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
