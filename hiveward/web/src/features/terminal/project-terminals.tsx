import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { HiveWardTerminal } from '@shared/api'
import { LoaderCircle, Plus, SquareTerminal, X } from 'lucide-react'
import { exitBlockReason } from '@/lib/exit-region'
import { terminalStatus, terminalTitle } from '@/lib/hiveward-format'
import {
  useHiveWardClose,
  useHiveWardCreate,
  useHiveWardTerminals,
} from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { useExitRegion } from '@/lib/machine'
import { insidePath } from '@/lib/project-for-path'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AgentLogo } from '@/components/hiveward/agent-logo'
import { StatusDot } from '@/components/hiveward/status-dot'
import { useFocusAgent } from '@/features/live/agent-console'
import { useSeatTitle } from '@/features/session/use-seat-title'
import { TerminalView } from './terminal-view'

const NEW_AGENTS = [
  { agent: 'claude', label: 'Claude Code' },
  { agent: 'codex', label: 'ChatGPT' },
  { agent: 'kimi', label: 'Kimi Code' },
  { agent: 'opencode', label: 'OpenCode' },
] as const

/**
 * 业务 / 项目主页的「现场」：这个目录里的所有终端竖着排在左边（像桌面端的会话列表），右边是真终端（能看能打字）。
 * + 新开 Agent 或普通终端（看项目时开在项目里）；× 关掉终端（Agent 也会一起退出，先确认）。
 * 选中哪个记在网址里（?t=handle）；选中的 Agent 开的网页显示在右栏浏览器里。
 */
export function ProjectTerminals({
  businessId,
  projectId,
  workspacePath,
  selected,
}: {
  businessId: string
  /** 看的是业务里的某个项目 */
  projectId?: string
  /** 业务目录，或项目目录 */
  workspacePath: string
  selected?: string
}) {
  const { data, error } = useHiveWardTerminals()
  const navigate = useNavigate()
  const create = useHiveWardCreate()
  const close = useHiveWardClose()
  const region = useExitRegion()
  const [closing, setClosing] = useState<HiveWardTerminal | null>(null)
  const terminals = (data ?? []).filter((t) =>
    insidePath(t.project, workspacePath)
  )
  const current = terminals.find((t) => t.handle === selected) ?? terminals[0]
  // 刚新开的终端可能还没出现在列表里，先照网址里的显示
  const handle = current?.handle ?? selected
  useFocusAgent(current?.agent ? current.handle : undefined)
  const seat = useSeatTitle()
  // 坐在座位上的写职位，其余写终端自己的标题
  const tabTitle = (t: HiveWardTerminal) =>
    seat.ofTerminal(t.handle) ?? terminalTitle(t.title) ?? t.agent ?? tr('终端')

  const select = (t?: string) =>
    navigate({
      to: '/b/$businessId',
      params: { businessId },
      search: { project: projectId, tab: 'live', t },
      replace: true,
    })

  // 网址里选的终端已经关掉了：换到第一个
  useEffect(() => {
    if (data && selected && !terminals.some((t) => t.handle === selected)) {
      if (!create.isPending && create.data?.handle !== selected) {
        void select(terminals[0]?.handle)
      }
    }
  })

  const open = (agent?: (typeof NEW_AGENTS)[number]['agent']) =>
    create.mutate(
      { project: workspacePath, agent, projectId },
      { onSuccess: ({ handle: h }) => void select(h) }
    )

  return (
    <div className='flex min-h-[360px] flex-1 overflow-hidden rounded-xl border bg-panel'>
      <div className='flex w-56 shrink-0 flex-col border-e'>
        <div className='flex h-10 shrink-0 items-center gap-1 border-b ps-3 pe-1.5'>
          <span className='flex-1 text-xs font-medium text-muted-foreground'>
            {tr('终端 {0}', [terminals.length > 0 && terminals.length])}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              title={tr('新开终端')}
              aria-label={tr('新开终端')}
              disabled={create.isPending}
              className='grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground'
            >
              {create.isPending ? (
                <LoaderCircle className='size-3.5 animate-spin' />
              ) : (
                <Plus className='size-3.5' />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align='start' className='w-44'>
              {NEW_AGENTS.map((a) => {
                const blocked = exitBlockReason(region, a.agent)
                return (
                  <DropdownMenuItem
                    key={a.agent}
                    disabled={!!blocked}
                    title={blocked ?? undefined}
                    onClick={() => open(a.agent)}
                  >
                    <AgentLogo agent={a.agent} className='size-4' />
                    {a.label}
                    {blocked && (
                      <span className='ms-auto text-[11px] text-danger'>
                        {tr('出口不合规')}
                      </span>
                    )}
                  </DropdownMenuItem>
                )
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => open()}>
                <SquareTerminal />
                {tr('普通终端')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {(create.error ?? error) && (
          <p className='border-b px-3 py-1.5 text-xs text-danger'>
            {(create.error ?? error)?.message}
          </p>
        )}
        <ul className='min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5'>
          {terminals.map((t) => (
            <li
              key={t.handle}
              className={cn(
                'group relative flex h-8 items-center rounded-md text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                t.handle === handle && 'bg-accent text-foreground'
              )}
            >
              <button
                type='button'
                title={tabTitle(t)}
                onClick={() => void select(t.handle)}
                className='flex h-full min-w-0 flex-1 items-center gap-2 ps-2 pe-7 outline-none'
              >
                {t.agent ? (
                  <AgentLogo agent={t.agent} className='size-3.5' />
                ) : (
                  <SquareTerminal className='size-3.5 shrink-0' />
                )}
                <span className='min-w-0 flex-1 truncate text-start'>
                  {tabTitle(t)}
                </span>
                {t.agent && <StatusDot status={terminalStatus(t.status)} />}
              </button>
              <button
                type='button'
                title={tr('关掉这个终端')}
                aria-label={tr('关掉这个终端')}
                onClick={() => setClosing(t)}
                className='absolute end-1 grid size-6 place-items-center rounded bg-accent opacity-0 group-hover:opacity-100 hover:bg-background'
              >
                <X className='size-3' />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {handle ? (
        <TerminalView key={handle} handle={handle} className='min-w-0 flex-1' />
      ) : (
        <div className='grid flex-1 place-items-center text-center text-sm text-muted-foreground'>
          <div>
            <p>
              {tr('{0}里还没有终端。', [
                projectId ? tr('这个项目') : tr('这块业务'),
              ])}
            </p>
            <p className='mt-1 text-xs'>
              {tr('点左上角的 + 新开一个 Agent 或普通终端。')}
            </p>
          </div>
        </div>
      )}

      <AlertDialog
        open={!!closing}
        onOpenChange={(o) => {
          if (!o) {
            setClosing(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tr('关掉「{0}」？', [closing ? tabTitle(closing) : ''])}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {closing?.agent
                ? tr(
                    '里面的 Agent 会一起退出，没做完的活会停下。任务记录还在。'
                  )
                : tr('终端里正在跑的命令会被结束。')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('取消')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (closing) {
                  close.mutate(closing.handle)
                }
              }}
            >
              {tr('关掉')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
