import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { AgentKind, BusinessSummary, Project } from '@shared/api'
import { Ellipsis, LoaderCircle, Pencil, Timer, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { exitBlockReason } from '@/lib/exit-region'
import { useCreateProject, useUpdateProject } from '@/lib/hiveward-api'
import { LEADER_LABEL, LEADERS } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { useExitRegion } from '@/lib/machine'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AgentLogo } from '@/components/hiveward/agent-logo'
import { PatrolDialog } from './patrol-dialog'

/**
 * 项目页标题右边的「…」：改名、巡检设置、删除项目。
 * 删除 = 从 HiveWard 里拿掉（后台归档）：目录和文件都不动，Leader 终端也不关；
 * 项目里还有在干的活或待复核的单时后台会拒绝，原因照实说。删错了在业务的「…」里恢复。
 */
export function ProjectActions({ project }: { project: Project }) {
  const [renaming, setRenaming] = useState(false)
  const [patrolling, setPatrolling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const update = useUpdateProject()
  const navigate = useNavigate()
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={tr('项目设置')}
          className='grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground'
        >
          <Ellipsis className='size-4' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-40'>
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <Pencil />
            {tr('改名')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setPatrolling(true)}>
            <Timer />
            {tr('巡检设置')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant='destructive'
            onClick={() => setDeleting(true)}
          >
            <Trash2 />
            {tr('删除项目')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog
        key={String(renaming)}
        open={renaming}
        project={project}
        onClose={() => setRenaming(false)}
      />
      <PatrolDialog
        key={`patrol-${patrolling}`}
        open={patrolling}
        project={project}
        onClose={() => setPatrolling(false)}
      />
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tr('删除项目「{0}」？', [project.name])}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tr(
                '只是从 HiveWard 里拿掉：目录和文件都不动，Leader 的终端也不关，做过的任务记录还在。删错了可以在业务的「…」菜单里恢复。'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('取消')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                update.mutate(
                  { project, status: 'archived' },
                  {
                    onSuccess: () => {
                      toast.success(tr('已删除项目「{0}」', [project.name]))
                      void navigate({
                        to: '/b/$businessId',
                        params: { businessId: project.businessId },
                      })
                    },
                    onError: (e) => toast.error(tr('没删成：{0}', [e.message])),
                  }
                )
              }
            >
              {tr('删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
                onError: (err) => toast.error(tr('没改成：{0}', [err.message])),
              }
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>{tr('改项目名')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter>
            <Button type='submit' disabled={!name.trim() || update.isPending}>
              {tr('保存')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 新建项目：左栏业务名后面悬停出来的 + 打开 */
export function NewProjectDialog({
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
  const [agent, setAgent] = useState<AgentKind | null>(null)
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
                      tr('「{0}」建好了，Leader Agent 没开成：{1}', [
                        project.name,
                        leaderError.message,
                      ])
                    )
                  } else {
                    toast.success(
                      picked
                        ? tr('「{0}」建好了，Leader Agent 正在开', [
                            project.name,
                          ])
                        : tr('「{0}」建好了', [project.name])
                    )
                  }
                  onClose()
                },
              }
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {tr('在「{0}」里新建项目', [business.name])}
            </DialogTitle>
            <DialogDescription>
              {tr(
                'Leader 可以不开，CEO 能直接管项目；以后在架构图上项目后面点 + 也能加。'
              )}
            </DialogDescription>
          </DialogHeader>

          <div className='grid gap-1.5'>
            <label htmlFor='project-name' className='text-xs font-medium'>
              {tr('项目名')}
            </label>
            <Input
              id='project-name'
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tr('比如：运营、构建、某个选题')}
            />
          </div>

          <div className='grid gap-1.5'>
            <label htmlFor='project-dir' className='text-xs font-medium'>
              {tr('子目录')}
              <span className='text-muted-foreground'>
                {tr('（可不填，就是整个业务目录）')}
              </span>
            </label>
            <Input
              id='project-dir'
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder={tr('比如 选题/AI 省钱，没有就新建')}
              className='font-mono text-xs'
            />
          </div>

          <div className='grid gap-1.5'>
            <span className='text-xs font-medium'>
              Leader Agent{' '}
              <span className='text-muted-foreground'>{tr('（可不开）')}</span>
            </span>
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
                {tr('先不开')}
              </button>
            </div>
          </div>

          {picked && (
            <div className='grid gap-1.5'>
              <label htmlFor='project-prompt' className='text-xs font-medium'>
                {tr('第一句话')}
                <span className='text-muted-foreground'>
                  {tr('（可不填）')}
                </span>
              </label>
              <Textarea
                id='project-prompt'
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={tr('开出来就交给它的活')}
                className='min-h-20 text-[13px]'
              />
            </div>
          )}

          {create.error && (
            <p className='text-xs text-danger'>{create.error.message}</p>
          )}
          <DialogFooter>
            <Button type='button' variant='ghost' onClick={onClose}>
              {tr('取消')}
            </Button>
            <Button type='submit' disabled={!name.trim() || create.isPending}>
              {create.isPending && <LoaderCircle className='animate-spin' />}
              {picked ? tr('建项目并开 Leader Agent') : tr('建项目')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
