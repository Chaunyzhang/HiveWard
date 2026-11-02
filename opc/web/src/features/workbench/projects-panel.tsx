import { useState } from 'react'
import type { AgentKind, BusinessSummary, Project } from '@shared/api'
import {
  Archive,
  ArchiveRestore,
  Ellipsis,
  LoaderCircle,
  Pencil,
  Plus,
} from 'lucide-react'
import { toast } from 'sonner'
import { exitBlockReason } from '@/lib/exit-region'
import { useExitRegion } from '@/lib/machine'
import { useCreateProject, useUpdateProject } from '@/lib/opc-api'
import { agentStatus, LEADER_LABEL, LEADERS } from '@/lib/opc-format'
import { useOrcaTerminals } from '@/lib/orca-live'
import { cn } from '@/lib/utils'
import { useSettledStatus } from '@/hooks/use-settled-status'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AgentLogo } from '@/components/opc/agent-logo'
import { StatusDot } from '@/components/opc/status-dot'

/**
 * 业务下面的项目：一个项目一个 Leader Agent。视频一个选题一个项目，App 分运营、构建，
 * 分几个由老板定。点一行打开那个项目的 Leader Agent；没开过的在详情里选一家开。
 */
export function ProjectList({
  business,
  onOpen,
}: {
  business: BusinessSummary
  onOpen: (project: Project) => void
}) {
  const [showArchived, setShowArchived] = useState(false)
  const all = business.projects ?? []
  const active = all.filter((p) => p.status === 'active')
  const archived = all.filter((p) => p.status === 'archived')

  return (
    <div className='px-2 pb-3'>
      {active.length === 0 && (
        <p className='px-2 pb-2 text-xs leading-5 text-muted-foreground'>
          还没有项目。按事情分，不用分太细：视频一个选题一个项目，App
          分「运营」「构建」。
        </p>
      )}
      <ul>
        {active.map((p) => (
          <ProjectRow key={p.id} project={p} onOpen={() => onOpen(p)} />
        ))}
      </ul>
      {archived.length > 0 && (
        <>
          <button
            type='button'
            onClick={() => setShowArchived((v) => !v)}
            className='mt-1 px-2 text-[11px] text-muted-foreground hover:text-foreground'
          >
            {showArchived ? '收起' : `已归档 ${archived.length}`}
          </button>
          {showArchived && (
            <ul className='opacity-60'>
              {archived.map((p) => (
                <ProjectRow key={p.id} project={p} onOpen={() => onOpen(p)} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function ProjectRow({
  project: p,
  onOpen,
}: {
  project: Project
  onOpen: () => void
}) {
  const { data } = useOrcaTerminals()
  const leader = p.leader
  const terminal =
    leader && data
      ? (data.find((t) => t.handle === leader.terminal) ?? null)
      : undefined
  const status = useSettledStatus(
    leader
      ? agentStatus({
          terminal,
          state: leader.state,
          liveness: leader.liveness,
        })
      : undefined
  )
  const [renaming, setRenaming] = useState(false)
  const update = useUpdateProject()
  const archived = p.status === 'archived'

  return (
    <li className='group flex items-center rounded-md hover:bg-accent'>
      <button
        type='button'
        onClick={onOpen}
        className='flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-start'
      >
        <StatusDot status={status ?? 'idle'} />
        <span className='min-w-0 flex-1'>
          <span className='flex items-center gap-2'>
            <span className='truncate text-[13px]'>{p.name}</span>
            {p.dir && (
              <span className='truncate font-mono text-[11px] text-muted-foreground'>
                {p.dir}
              </span>
            )}
          </span>
          {leader?.activity && (
            <span className='block truncate text-xs text-muted-foreground'>
              {leader.activity}
            </span>
          )}
        </span>
        {leader && leader.liveness !== 'exited' ? (
          <AgentLogo agent={leader.agent} className='size-4 shrink-0' />
        ) : (
          <span className='shrink-0 text-[11px] text-muted-foreground'>
            {leader ? 'Leader Agent 已退出' : '还没开 Leader Agent'}
          </span>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label='项目设置'
          className='me-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100'
        >
          <Ellipsis className='size-3.5' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-36'>
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <Pencil />
            改名
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              update.mutate(
                { project: p, status: archived ? 'active' : 'archived' },
                { onError: (e) => toast.error(`没改成：${e.message}`) }
              )
            }
          >
            {archived ? <ArchiveRestore /> : <Archive />}
            {archived ? '恢复' : '归档'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog
        key={String(renaming)}
        open={renaming}
        project={p}
        onClose={() => setRenaming(false)}
      />
    </li>
  )
}

function RenameDialog({
  open,
  project,
  onClose,
}: {
  open: boolean
  project: Project
  onClose: () => void
}) {
  const [name, setName] = useState(project.name)
  const update = useUpdateProject()
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-sm'>
        <form
          className='grid gap-4'
          onSubmit={(e) => {
            e.preventDefault()
            const next = name.trim()
            if (!next || next === project.name) {
              onClose()
              return
            }
            update.mutate(
              { project, name: next },
              {
                onSuccess: onClose,
                onError: (err) => toast.error(`没改成：${err.message}`),
              }
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>改项目名</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter>
            <Button type='submit' disabled={!name.trim() || update.isPending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 面板右上角的「新建项目」 */
export function NewProjectButton({ business }: { business: BusinessSummary }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type='button'
        onClick={() => setOpen(true)}
        className='flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
      >
        <Plus className='size-3.5' />
        新建项目
      </button>
      <NewProjectDialog
        key={String(open)}
        open={open}
        business={business}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

function NewProjectDialog({
  open,
  business,
  onClose,
}: {
  open: boolean
  business: BusinessSummary
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [agent, setAgent] = useState<AgentKind | null>('claude')
  const [prompt, setPrompt] = useState('')
  const create = useCreateProject(business.id)
  const region = useExitRegion()
  const blocked = (a: AgentKind) => exitBlockReason(region, a)
  const picked = agent && !blocked(agent) ? agent : null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form
          className='grid gap-4'
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim() || create.isPending) {
              return
            }
            create.mutate(
              {
                name: name.trim(),
                dir: dir.trim() || undefined,
                agent: picked ?? undefined,
                prompt: (picked && prompt.trim()) || undefined,
              },
              {
                onSuccess: ({ project, leaderError }) => {
                  if (leaderError) {
                    toast.warning(
                      `「${project.name}」建好了，Leader Agent 没开成：${leaderError.message}`
                    )
                  } else {
                    toast.success(
                      picked
                        ? `「${project.name}」建好了，Leader Agent 正在开`
                        : `「${project.name}」建好了`
                    )
                  }
                  onClose()
                },
              }
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>在「{business.name}」里新建项目</DialogTitle>
            <DialogDescription>
              一个项目一个 Leader Agent，Leader Agent 再派下属。
            </DialogDescription>
          </DialogHeader>

          <div className='grid gap-1.5'>
            <label htmlFor='project-name' className='text-xs font-medium'>
              项目名
            </label>
            <Input
              id='project-name'
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='比如：运营、构建、某个选题'
            />
          </div>

          <div className='grid gap-1.5'>
            <label htmlFor='project-dir' className='text-xs font-medium'>
              子目录{' '}
              <span className='text-muted-foreground'>
                （可不填，就是整个业务目录）
              </span>
            </label>
            <Input
              id='project-dir'
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder='比如 选题/AI 省钱，没有就新建'
              className='font-mono text-xs'
            />
          </div>

          <div className='grid gap-1.5'>
            <span className='text-xs font-medium'>Leader Agent</span>
            <div className='flex flex-wrap gap-1.5'>
              {LEADERS.map((a) => {
                const reason = blocked(a)
                return (
                  <button
                    key={a}
                    type='button'
                    disabled={!!reason}
                    title={reason ?? undefined}
                    onClick={() => setAgent(a)}
                    className={cn(
                      'flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs disabled:opacity-40',
                      picked === a
                        ? 'border-foreground bg-accent'
                        : 'hover:bg-accent'
                    )}
                  >
                    <AgentLogo agent={a} className='size-3.5' />
                    {LEADER_LABEL[a]}
                  </button>
                )
              })}
              <button
                type='button'
                onClick={() => setAgent(null)}
                className={cn(
                  'h-8 rounded-md border px-3 text-xs text-muted-foreground',
                  !picked
                    ? 'border-foreground bg-accent text-foreground'
                    : 'hover:bg-accent'
                )}
              >
                先不开
              </button>
            </div>
          </div>

          {picked && (
            <div className='grid gap-1.5'>
              <label htmlFor='project-prompt' className='text-xs font-medium'>
                第一句话{' '}
                <span className='text-muted-foreground'>（可不填）</span>
              </label>
              <Textarea
                id='project-prompt'
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder='开出来就交给它的活'
                className='min-h-20 text-[13px]'
              />
            </div>
          )}

          {create.error && (
            <p className='text-xs text-danger'>{create.error.message}</p>
          )}
          <DialogFooter>
            <Button type='button' variant='ghost' onClick={onClose}>
              取消
            </Button>
            <Button type='submit' disabled={!name.trim() || create.isPending}>
              {create.isPending && <LoaderCircle className='animate-spin' />}
              {picked ? '建项目并开 Leader Agent' : '建项目'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
