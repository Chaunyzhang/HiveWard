import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { OrcaTerminal } from '@shared/api'
import { LoaderCircle, Plus, SquareTerminal, X } from 'lucide-react'
import { exitBlockReason } from '@/lib/exit-region'
import { useExitRegion } from '@/lib/machine'
import { terminalStatus } from '@/lib/opc-format'
import { useOrcaClose, useOrcaCreate, useOrcaTerminals } from '@/lib/orca-live'
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
import { AgentLogo } from '@/components/opc/agent-logo'
import { StatusDot } from '@/components/opc/status-dot'
import { TerminalView } from './terminal-view'

const NEW_AGENTS = [
  { agent: 'claude', label: 'Claude Code' },
  { agent: 'codex', label: 'Codex' },
  { agent: 'kimi', label: 'Kimi Code' },
] as const

const inside = (path: string, root: string) =>
  path === root || path.startsWith(`${root}/`)

// 终端标题前面常带 Agent 自己画的转圈 / 星号，去掉
const tabTitle = (t: OrcaTerminal) =>
  t.title?.replace(/^[⠀-⣿✳✻✽✶✢·*]+\s*/u, '').trim() || (t.agent ?? '终端')

/**
 * 项目页「终端」：这个项目目录里的所有终端，一个终端一个标签，下面是真终端（能看能打字）。
 * + 新开 Agent 或普通终端；× 关掉终端（Agent 也会一起退出，先确认）。
 * 选中哪个记在网址里（?t=handle），架构图点 Agent 也是跳到这里。
 */
export function ProjectTerminals({
  businessId,
  workspacePath,
  selected,
}: {
  businessId: string
  workspacePath: string
  selected?: string
}) {
  const { data, error } = useOrcaTerminals()
  const navigate = useNavigate()
  const create = useOrcaCreate()
  const close = useOrcaClose()
  const region = useExitRegion()
  const [closing, setClosing] = useState<OrcaTerminal | null>(null)
  const terminals = (data ?? []).filter((t) => inside(t.project, workspacePath))
  const current = terminals.find((t) => t.handle === selected) ?? terminals[0]
  // 刚新开的终端可能还没出现在列表里，先照网址里的显示
  const handle = current?.handle ?? selected

  const select = (t?: string) =>
    navigate({
      to: '/b/$businessId',
      params: { businessId },
      search: { tab: 'terminal', t },
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
      { project: workspacePath, agent },
      { onSuccess: ({ handle: h }) => void select(h) }
    )

  return (
    <div className='flex min-h-[360px] flex-1 flex-col overflow-hidden rounded-xl border bg-panel'>
      <div className='flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5'>
        {terminals.map((t) => (
          <div
            key={t.handle}
            className={cn(
              'group flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md ps-2 pe-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              t.handle === handle && 'bg-accent text-foreground'
            )}
          >
            <button
              type='button'
              onClick={() => void select(t.handle)}
              className='flex min-w-0 items-center gap-1.5'
            >
              {t.agent ? (
                <AgentLogo agent={t.agent} className='size-3.5' />
              ) : (
                <SquareTerminal className='size-3.5 shrink-0' />
              )}
              <span className='truncate'>{tabTitle(t)}</span>
              {t.agent && <StatusDot status={terminalStatus(t.status)} />}
            </button>
            <button
              type='button'
              title='关掉这个终端'
              aria-label='关掉这个终端'
              onClick={() => setClosing(t)}
              className='grid size-5 place-items-center rounded opacity-0 group-hover:opacity-100 hover:bg-background'
            >
              <X className='size-3' />
            </button>
          </div>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger
            title='新开终端'
            aria-label='新开终端'
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
                      出口不合规
                    </span>
                  )}
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => open()}>
              <SquareTerminal />
              普通终端
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {(create.error ?? error) && (
          <span className='ms-2 truncate text-xs text-danger'>
            {(create.error ?? error)?.message}
          </span>
        )}
      </div>

      {handle ? (
        <TerminalView key={handle} handle={handle} className='flex-1' />
      ) : (
        <div className='grid flex-1 place-items-center text-center text-sm text-muted-foreground'>
          <div>
            <p>这块业务里还没有终端。</p>
            <p className='mt-1 text-xs'>
              点左上角的 + 新开一个 Agent 或普通终端。
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
              关掉「{closing ? tabTitle(closing) : ''}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {closing?.agent
                ? '里面的 Agent 会一起退出，没做完的活会停下。任务记录还在。'
                : '终端里正在跑的命令会被结束。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (closing) {
                  close.mutate(closing.handle)
                }
              }}
            >
              关掉
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
