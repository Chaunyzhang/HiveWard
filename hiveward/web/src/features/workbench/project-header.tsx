import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { BusinessSummary, Project } from '@shared/api'
import {
  ArchiveRestore,
  Ellipsis,
  Pause,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  useRemoveBusiness,
  useUpdateBusiness,
  useUpdateProject,
} from '@/lib/hiveward-api'
import { tr } from '@/lib/i18n'
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ProjectLogo } from '@/components/hiveward/project-logo'
import { PatrolChip, PresetBadge } from './patrol-dialog'
import { ProjectActions } from './projects-panel'

/**
 * 主页顶部：标题 + 一排标签。集团总览、业务主页、项目主页都用它，换标签时标题和标签不动、不位移。
 * 业务 / 项目：logo、名字、目录、管理菜单；看项目时名字前面带上它属于哪块业务（点了回业务主页）。
 * 派活不在这里：点架构图里的 Leader Agent，在它的对话里说。
 */
export type HomeTab = 'topology' | 'tasks' | 'live'

const LABELS: Record<HomeTab, string> = {
  topology: tr('架构图'),
  tasks: tr('任务'),
  live: tr('现场'),
}

/** 集团的页面（架构图、任务）各是左栏里的一项，没有标签栏 */
const GROUP_TITLES: Partial<Record<HomeTab, string>> = {
  tasks: tr('任务'),
  topology: tr('架构图'),
}
export const HOME_TABS: HomeTab[] = ['topology', 'tasks', 'live']

export function HomeHeader({
  business,
  project,
  tab,
  counts,
}: {
  /** 不传是集团总览 */
  business?: BusinessSummary
  /** 看的是业务里的某个项目 */
  project?: Project
  tab: HomeTab
  /** 标签后面的数字（任务后面是待办几件） */
  counts?: Partial<Record<HomeTab, number>>
}) {
  const path = project?.path ?? business?.workspacePath
  return (
    <div className='space-y-4'>
      <div className='flex min-h-10 items-start gap-3'>
        {business && <ProjectLogo project={business} size={40} />}
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-2'>
            {business && project && (
              <>
                <Link
                  to='/b/$businessId'
                  params={{ businessId: business.id }}
                  className='shrink-0 text-lg text-muted-foreground hover:text-foreground'
                >
                  {business.name}
                </Link>
                <span className='text-lg text-muted-foreground/50'>/</span>
              </>
            )}
            <h1 className='truncate text-lg font-semibold'>
              {project?.name ?? business?.name ?? GROUP_TITLES[tab]}
            </h1>
            {project && <PresetBadge project={project} />}
            {business && !project && business.kind && (
              <span className='shrink-0 rounded bg-muted px-1.5 text-[11px] leading-5 whitespace-nowrap text-muted-foreground'>
                {business.kind === 'git' ? 'git' : tr('文件夹')}
              </span>
            )}
            {business?.missing && (
              <span className='rounded bg-danger/10 px-1.5 text-[11px] leading-5 text-danger'>
                {tr('目录不在了')}
              </span>
            )}
            {business?.status === 'paused' && (
              <span className='rounded bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground'>
                {tr('已暂停')}
              </span>
            )}
          </div>
          <div className='flex min-w-0 items-center gap-2'>
            <p
              title={path}
              className='min-w-0 truncate font-mono text-xs text-muted-foreground'
            >
              {path
                ? path.replace(/^\/Users\/[^/]+/, '~')
                : tr('所有业务、所有电脑合在一起看')}
            </p>
            {project && <PatrolChip project={project} />}
          </div>
        </div>
        {business && !project && <ProjectMenu project={business} />}
        {project && <ProjectActions project={project} />}
      </div>
      {business && (
        <nav className='flex gap-1 overflow-x-auto border-b whitespace-nowrap'>
          {HOME_TABS.map((t) => {
            const cls = cn(
              '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 pb-2 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground',
              t === tab
                ? 'border-foreground text-foreground'
                : 'border-transparent'
            )
            const count = counts?.[t] ? (
              <span
                className={cn(
                  'font-mono text-[11px]',
                  t === 'tasks' ? 'text-attention' : 'text-muted-foreground'
                )}
              >
                {counts[t]}
              </span>
            ) : null
            const search = t === 'topology' ? undefined : t
            return (
              <Link
                key={t}
                to='/b/$businessId'
                params={{ businessId: business.id }}
                search={{ project: project?.id, tab: search }}
                className={cls}
              >
                {LABELS[t]}
                {count}
              </Link>
            )
          })}
        </nav>
      )}
    </div>
  )
}

function ProjectMenu({ project }: { project: BusinessSummary }) {
  const update = useUpdateBusiness()
  const remove = useRemoveBusiness()
  const restore = useUpdateProject()
  const deleted = project.projects.filter((p) => p.status === 'archived')
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const paused = project.status === 'paused'

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={tr('业务设置')}
          className='grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground'
        >
          <Ellipsis className='size-4' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-44'>
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <Pencil />
            {tr('改名')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              update.mutate({
                id: project.id,
                status: paused ? 'active' : 'paused',
              })
            }
          >
            {paused ? <Play /> : <Pause />}
            {paused ? tr('恢复') : tr('暂停')}
          </DropdownMenuItem>
          {deleted.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className='text-xs font-normal text-muted-foreground'>
                {tr('恢复删掉的项目')}
              </DropdownMenuLabel>
              {deleted.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() =>
                    restore.mutate(
                      { project: p, status: 'active' },
                      {
                        onSuccess: () =>
                          toast.success(tr('已恢复「{0}」', [p.name])),
                        onError: (e) =>
                          toast.error(tr('没恢复成：{0}', [e.message])),
                      }
                    )
                  }
                >
                  <ArchiveRestore />
                  <span className='truncate'>{p.name}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant='destructive'
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
            {tr('删除业务')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {(update.error || remove.error) && (
        <p className='text-xs text-danger'>
          {(update.error ?? remove.error)?.message}
        </p>
      )}
      <RenameDialog
        key={String(renaming)}
        open={renaming}
        name={project.name}
        onOpenChange={setRenaming}
        onSave={(name) => update.mutate({ id: project.id, name })}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tr('删除业务「{0}」？', [project.name])}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tr(
                '只是从 HiveWard 里拿掉：磁盘上的目录和文件都不动，开着的终端也不关，做过的任务记录留着。以后想管，把这个目录再加成业务就回来了。'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('取消')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                remove.mutate(project.id, {
                  onSuccess: () => {
                    toast.success(tr('已删除业务「{0}」', [project.name]))
                    void navigate({ to: '/' })
                  },
                })
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
  name,
  onOpenChange,
  onSave,
}: {
  open: boolean
  name: string
  onOpenChange: (open: boolean) => void
  onSave: (name: string) => void
}) {
  const [value, setValue] = useState(name)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-sm'>
        <form
          className='grid gap-4'
          onSubmit={(e) => {
            e.preventDefault()
            const next = value.trim()
            if (next && next !== name) {
              onSave(next)
            }
            onOpenChange(false)
          }}
        >
          <DialogHeader>
            <DialogTitle>{tr('改业务名')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <DialogFooter>
            <Button
              type='button'
              variant='ghost'
              onClick={() => onOpenChange(false)}
            >
              {tr('取消')}
            </Button>
            <Button type='submit' disabled={!value.trim()}>
              {tr('保存')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
