import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { BusinessSummary, Project } from '@shared/api'
import { Ellipsis, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import { useRemoveBusiness, useUpdateBusiness } from '@/lib/opc-api'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ProjectLogo } from '@/components/opc/project-logo'

/**
 * 业务 / 项目主页顶部：logo、名字、目录、管理菜单，下面是标签。
 * 看项目时名字前面带上它属于哪块业务（点了回业务主页）。
 * 派活不在这里：点架构图里的 Leader Agent，在它的对话里说。
 */
export type ProjectTab = 'overview' | 'live' | 'timeline'

const TABS: { value: ProjectTab; label: string }[] = [
  { value: 'overview', label: '概览' },
  { value: 'live', label: '现场' },
  { value: 'timeline', label: '时间线' },
]

export function ProjectHeader({
  business,
  project,
  tab,
}: {
  business: BusinessSummary
  /** 看的是业务里的某个项目 */
  project?: Project
  tab: ProjectTab
}) {
  const path = project?.path ?? business.workspacePath
  return (
    <div className='space-y-4'>
      <div className='flex items-start gap-3'>
        <ProjectLogo project={business} size={40} />
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-2'>
            {project && (
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
              {project?.name ?? business.name}
            </h1>
            {!project && business.kind && (
              <span className='rounded bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground'>
                {business.kind === 'git' ? 'git' : '文件夹'}
              </span>
            )}
            {business.missing && (
              <span className='rounded bg-danger/10 px-1.5 text-[11px] leading-5 text-danger'>
                目录不在了
              </span>
            )}
            {business.status === 'paused' && (
              <span className='rounded bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground'>
                已暂停
              </span>
            )}
          </div>
          <p
            title={path}
            className='truncate font-mono text-xs text-muted-foreground'
          >
            {path.replace(/^\/Users\/[^/]+/, '~')}
          </p>
        </div>
        {!project && <ProjectMenu project={business} />}
      </div>
      <nav className='flex gap-1 border-b'>
        {TABS.map((t) => (
          <Link
            key={t.value}
            to='/b/$businessId'
            params={{ businessId: business.id }}
            search={{
              project: project?.id,
              tab: t.value === 'overview' ? undefined : t.value,
            }}
            className={cn(
              '-mb-px border-b-2 px-3 pb-2 text-sm text-muted-foreground transition-colors hover:text-foreground',
              t.value === tab
                ? 'border-foreground text-foreground'
                : 'border-transparent'
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}

function ProjectMenu({ project }: { project: BusinessSummary }) {
  const update = useUpdateBusiness()
  const remove = useRemoveBusiness()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const paused = project.status === 'paused'

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label='业务设置'
          className='grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground'
        >
          <Ellipsis className='size-4' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-44'>
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <Pencil />
            改名
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
            {paused ? '恢复' : '暂停'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant='destructive'
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
            移除业务
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
            <AlertDialogTitle>移除「{project.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              只是不再把它当业务管，磁盘上的目录和文件都不动，做过的任务记录也留着。以后想管再加回来。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                remove.mutate(project.id, {
                  onSuccess: () => void navigate({ to: '/' }),
                })
              }
            >
              移除
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
            <DialogTitle>改业务名</DialogTitle>
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
              取消
            </Button>
            <Button type='submit' disabled={!value.trim()}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
