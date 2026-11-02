import { useMemo, useState } from 'react'
import type { OrcaCreateTerminalRequest, OrcaTerminal } from '@shared/api'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { exitBlockReason } from '@/lib/exit-region'
import { useExitRegion } from '@/lib/machine'
import { terminalStatus } from '@/lib/opc-format'
import {
  useOrcaCreate,
  useOrcaProjects,
  useOrcaTerminals,
} from '@/lib/orca-live'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { AgentLogo, AgentName } from '@/components/opc/agent-logo'
import { StatusDot } from '@/components/opc/status-dot'
import { AgentConsole } from './agent-console'

const AGENTS: NonNullable<OrcaCreateTerminalRequest['agent']>[] = [
  'claude',
  'codex',
  'kimi',
]

/**
 * 现场：直连本机 Orca，看每个终端里的 Agent 正在干什么，并且能直接打字。
 * 左边是 Orca 里所有终端，右边是选中终端的整屏画面（每秒刷新）+ 输入框。
 */
export function Live() {
  const terminals = useOrcaTerminals()
  const [picked, setPicked] = useState<string | null>(null)
  const list = useMemo(() => terminals.data ?? [], [terminals.data])
  const current = list.find((t) => t.handle === picked) ?? list[0] ?? null

  return (
    <div className='grid h-[calc(100svh-3rem)] grid-cols-[280px_minmax(0,1fr)] gap-5 p-5'>
      <section className='flex min-h-0 flex-col overflow-hidden rounded-xl panel'>
        <header className='flex h-12 shrink-0 items-center gap-2 px-4'>
          <h2 className='text-[13px] font-medium'>终端</h2>
          <span className='text-xs text-muted-foreground'>
            {list.length || ''}
          </span>
          <NewAgent onCreated={setPicked} />
        </header>
        <div className='min-h-0 flex-1 overflow-y-auto px-2 pb-3'>
          {terminals.isError ? (
            <p className='px-2 py-6 text-xs leading-5 text-danger'>
              {terminals.error.message}
            </p>
          ) : (
            <TerminalList
              list={list}
              currentId={current?.handle}
              onPick={setPicked}
            />
          )}
        </div>
      </section>

      {current ? (
        <AgentConsole
          key={current.handle}
          terminal={current}
          className='rounded-xl panel'
        />
      ) : (
        <section className='flex items-center justify-center rounded-xl panel text-[13px] text-muted-foreground'>
          {terminals.isLoading
            ? '连接引擎…'
            : '还没有终端，点左上角 + 新开一个 Agent'}
        </section>
      )}
    </div>
  )
}

function TerminalList({
  list,
  currentId,
  onPick,
}: {
  list: OrcaTerminal[]
  currentId?: string
  onPick: (h: string) => void
}) {
  const groups = new Map<string, OrcaTerminal[]>()
  for (const t of list)
    groups.set(t.project, [...(groups.get(t.project) ?? []), t])

  return (
    <div className='space-y-4'>
      {[...groups].map(([project, items]) => (
        <div key={project}>
          <h3
            className='mb-0.5 truncate px-2 text-xs text-muted-foreground'
            title={project}
          >
            {project.split('/').pop()}
          </h3>
          <ul className='space-y-0.5'>
            {items.map((t) => (
              <li key={t.handle}>
                <button
                  type='button'
                  data-open={t.handle === currentId}
                  onClick={() => onPick(t.handle)}
                  className='block w-full rounded-md hover-box px-2 py-1.5 text-start'
                >
                  <span className='flex items-center gap-2'>
                    {t.agent ? (
                      <StatusDot status={terminalStatus(t.status)} />
                    ) : (
                      <span className='size-1.5 shrink-0 rounded-full bg-muted-foreground/25' />
                    )}
                    <span className='truncate text-[13px]'>
                      {t.title || '终端'}
                    </span>
                    <span className='ms-auto shrink-0 text-[11px] text-muted-foreground'>
                      {t.agent ? (
                        <AgentName agent={t.agent} />
                      ) : (
                        <span className='font-mono'>shell</span>
                      )}
                    </span>
                  </span>
                  <span className='mt-0.5 block truncate ps-3.5 font-mono text-[11px] text-muted-foreground'>
                    {t.preview || ' '}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function NewAgent({ onCreated }: { onCreated: (handle: string) => void }) {
  const [open, setOpen] = useState(false)
  const projects = useOrcaProjects()
  const create = useOrcaCreate()
  const region = useExitRegion()
  const [project, setProject] = useState('')
  const chosen = project || projects.data?.[0]?.path || ''

  const start = (agent: OrcaCreateTerminalRequest['agent']) =>
    create.mutate(
      { project: chosen, agent },
      {
        onSuccess: (r) => {
          onCreated(r.handle)
          setOpen(false)
        },
        onError: (e) => toast.error(`没开起来：${e.message}`),
      }
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='新开 Agent'
          className='ms-auto flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
        >
          <Plus className='size-4' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-64 p-3'>
        <p className='mb-2 text-xs text-muted-foreground'>在哪个项目里</p>
        <select
          value={chosen}
          onChange={(e) => setProject(e.target.value)}
          className='h-8 w-full rounded-md border bg-transparent px-2 text-[13px]'
        >
          {(projects.data ?? []).map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
        <p className='mt-3 mb-2 text-xs text-muted-foreground'>启动</p>
        <div className='grid grid-cols-3 gap-1.5'>
          {AGENTS.map((a) => (
            <button
              key={a}
              type='button'
              disabled={
                !chosen || create.isPending || !!exitBlockReason(region, a)
              }
              title={exitBlockReason(region, a) ?? undefined}
              onClick={() => start(a)}
              className='flex h-8 items-center justify-center gap-1.5 rounded-md border hover-box font-mono text-xs disabled:opacity-40'
            >
              <AgentLogo agent={a} />
              {a}
            </button>
          ))}
        </div>
        <button
          type='button'
          disabled={!chosen || create.isPending}
          onClick={() => start(undefined)}
          className='mt-1.5 h-8 w-full rounded-md text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40'
        >
          只开终端
        </button>
      </PopoverContent>
    </Popover>
  )
}
