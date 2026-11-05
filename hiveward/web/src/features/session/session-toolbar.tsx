import {
  Check,
  Coffee,
  Ellipsis,
  FileDiff,
  FolderTree,
  Globe,
  ListTodo,
  MessagesSquare,
  Workflow,
} from 'lucide-react'
import { toast } from 'sonner'
import { useWorkspace, type SideTab } from '@/stores/workspace'
import { useBrowser } from '@/lib/desktop'
import { useHiveWardTerminals } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import {
  useSessionAwake,
  useToggleSessionAwake,
} from '@/lib/session-panels-api'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { AgentLogo } from '@/components/hiveward/agent-logo'
import { useSideScope } from '@/components/layout/side-panel'
import { useFocusedSession } from './use-focused-session'
import { useSeatTitle } from './use-seat-title'

/**
 * 顶栏右边一排图标按钮（像 Claude 桌面端 Code 页）：
 * 更改 · 浏览器 · 文件 · 更多（后台任务、计划、侧边对话、保持唤醒）。会话栏开关在左上角。
 * 右栏一次看一样，再点同一个按钮收起。浏览器随时能开；主页上（没打开会话）不放「更多」。
 */
export function SessionToolbar({
  className,
  offline,
}: {
  className?: string
  /** 会话在连不上的电脑上（远程下属的执行端离线）：作用于那台电脑的按钮都禁用，提示写这句；本机的侧边对话照常 */
  offline?: string
}) {
  const sideOpen = useWorkspace((s) => s.sideOpen)
  const sideTab = useWorkspace((s) => s.sideTab)
  const toggleSide = useWorkspace((s) => s.toggleSide)
  const { root } = useSideScope()
  const focused = useFocusedSession()
  const browser = useBrowser()
  const showing = (tab: SideTab) => sideOpen && sideTab === tab

  return (
    <div className={cn('flex shrink-0 items-center gap-0.5', className)}>
      {root && (
        <ToolButton
          label={tr('更改：还没提交的改动')}
          disabled={offline}
          pressed={showing('changes')}
          onClick={() => toggleSide('changes')}
        >
          <FileDiff />
        </ToolButton>
      )}
      {browser.control && (
        <ToolButton
          label={tr('浏览器')}
          disabled={offline}
          pressed={showing('browser')}
          onClick={() => toggleSide('browser')}
        >
          <Globe />
        </ToolButton>
      )}
      {root && (
        <ToolButton
          label={tr('文件')}
          disabled={offline}
          pressed={showing('files')}
          onClick={() => toggleSide('files')}
        >
          <FolderTree />
        </ToolButton>
      )}
      {focused && <MoreMenu showing={showing} offline={offline} />}
    </div>
  )
}

function ToolButton({
  label,
  pressed,
  onClick,
  children,
  badge,
  disabled,
}: {
  label: string
  /** 禁用时写原因（悬停提示里接在名字后面） */
  disabled?: string
  pressed?: boolean
  onClick: () => void
  children: React.ReactNode
  badge?: number
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          aria-label={label}
          aria-pressed={pressed}
          aria-disabled={!!disabled}
          onClick={disabled ? undefined : onClick}
          className={cn(
            'relative grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground [&_svg]:size-4',
            pressed && 'bg-accent text-foreground'
          )}
        >
          {children}
          {!!badge && <Badge n={badge} />}
        </button>
      </TooltipTrigger>
      <TooltipContent side='bottom'>
        {disabled ? `${label} · ${disabled}` : label}
      </TooltipContent>
    </Tooltip>
  )
}

function Badge({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cn(
        'absolute -end-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-working px-1 font-mono text-[9px] leading-none text-white',
        className
      )}
    >
      {n}
    </span>
  )
}

function MoreMenu({
  showing,
  offline,
}: {
  showing: (tab: SideTab) => boolean
  offline?: string
}) {
  const toggleSide = useWorkspace((s) => s.toggleSide)
  const setSideChat = useWorkspace((s) => s.setSideChat)
  const sideChat = useWorkspace((s) => s.sideChat)
  const focused = useFocusedSession()!
  const handle = focused.handle ?? null
  // 保持唤醒只管本机：局域网另一头的电脑不归这里开关
  const local = focused.machine === null
  const awake = useSessionAwake(local ? handle : null)
  const toggleAwake = useToggleSessionAwake(handle)
  const terminals = useHiveWardTerminals()
  const seat = useSeatTitle()
  const others = (focused.terminals ?? terminals.data ?? []).filter(
    (t) => t.agent && t.handle !== handle
  )
  const running = focused.running.length

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            aria-label={tr('更多')}
            className='relative grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent data-[state=open]:bg-accent data-[state=open]:text-foreground [&_svg]:size-4'
          >
            <Ellipsis />
            {running > 0 && <Badge n={running} />}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side='bottom'>{tr('更多')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align='end' className='w-60'>
        {offline && (
          <DropdownMenuLabel className='text-xs font-normal text-muted-foreground'>
            {offline}
          </DropdownMenuLabel>
        )}
        <DropdownMenuItem
          disabled={!!offline}
          onClick={() => toggleSide('tasks')}
          className={cn(showing('tasks') && 'bg-accent')}
        >
          <Workflow />
          {tr('后台任务')}
          {running > 0 && (
            <span className='ms-auto font-mono text-xs text-working'>
              {running}
            </span>
          )}
        </DropdownMenuItem>
        {handle && (
          <DropdownMenuItem
            disabled={!!offline}
            onClick={() => toggleSide('plan')}
            className={cn(showing('plan') && 'bg-accent')}
          >
            <ListTodo />
            {tr('计划')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            disabled={others.length === 0}
            className='gap-2 [&_svg]:text-muted-foreground [&_svg:not([class*=size-])]:size-4'
          >
            <MessagesSquare />
            {tr('侧边对话')}
            {others.length === 0 && (
              <span className='ms-auto text-xs text-muted-foreground'>
                {tr('没有别的会话')}
              </span>
            )}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className='w-64'>
            <DropdownMenuLabel className='text-xs text-muted-foreground'>
              {tr('在右栏并排打开')}
            </DropdownMenuLabel>
            {others.map((t) => (
              <DropdownMenuItem
                key={t.handle}
                onClick={() => {
                  setSideChat(t.handle)
                  if (!showing('chat')) {
                    toggleSide('chat')
                  }
                }}
                className={cn(sideChat === t.handle && 'bg-accent')}
              >
                <AgentLogo agent={t.agent} />
                <span className='min-w-0 flex-1 truncate'>
                  {seat.ofTerminal(t.handle) ?? (t.title || t.agent)}
                </span>
                <span className='max-w-24 shrink-0 truncate text-xs text-muted-foreground'>
                  {t.project.split(/[\\/]/).pop()}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {local && handle && awake.data && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              role='menuitemcheckbox'
              aria-checked={awake.data.on}
              disabled={toggleAwake.isPending || !!offline}
              onSelect={(e) => {
                e.preventDefault()
                toggleAwake.mutate(!awake.data!.on, {
                  onError: (err) =>
                    toast.error(tr('没开关成：{0}', [err.message])),
                })
              }}
            >
              <Coffee className={cn(awake.data.on && 'text-working')} />
              <span className='flex flex-col'>
                {tr('保持电脑唤醒')}
                <span className='text-xs text-muted-foreground'>
                  {tr('仅本次会话{0}', [
                    awake.data.on && !awake.data.active && tr(' · 还没生效'),
                  ])}
                </span>
              </span>
              {awake.data.on && <Check className='ms-auto' />}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
