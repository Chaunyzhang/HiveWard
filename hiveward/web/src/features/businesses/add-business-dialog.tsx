import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { FolderOpen, LoaderCircle } from 'lucide-react'
import { desktop } from '@/lib/desktop'
import { useRegisterBusiness } from '@/lib/hiveward-api'
import { tr } from '@/lib/i18n'
import { useMachineId } from '@/lib/machine'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

/**
 * 加业务：选一个目录（git 仓库或普通文件夹都行），它就成了一块业务，业务下面再分项目。
 * 在 HiveWard App 里看本机时可以用系统的选目录框；看别的电脑时只能手填那台电脑上的路径。
 */
export function AddBusinessDialog({
  open,
  onOpenChange,
  initialPath,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 架构图上没登记的目录点「登记成业务」时预先填好 */
  initialPath?: string
}) {
  const [path, setPath] = useState(initialPath ?? '')
  const [name, setName] = useState('')
  const add = useRegisterBusiness()
  const navigate = useNavigate()
  const remote = useMachineId() !== null
  const pick = !remote ? desktop?.pickFolder : undefined

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setPath('')
      setName('')
      add.reset()
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const p = path.trim()
    if (!p || add.isPending) {
      return
    }
    add.mutate(
      { path: p, name: name.trim() || undefined },
      {
        onSuccess: ({ business }) => {
          close(false)
          void navigate({
            to: '/b/$businessId',
            params: { businessId: business.id },
          })
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>{tr('加业务')}</DialogTitle>
            <DialogDescription>
              {tr(
                '选一个目录，git 仓库或普通文件夹都行。一个目录就是一块业务，业务下面再分项目，每个项目一个总 Agent。'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-1.5'>
            <label htmlFor='project-path' className='text-xs font-medium'>
              {tr('目录{0}', [remote && tr('（那台电脑上的路径）')])}
            </label>
            <div className='flex gap-2'>
              <Input
                id='project-path'
                autoFocus={!pick}
                value={path}
                onChange={(e) => {
                  setPath(e.target.value)
                  add.reset()
                }}
                placeholder={tr('/Users/你/Projects/某个目录')}
                className='font-mono text-xs'
              />
              {pick && (
                <Button
                  type='button'
                  variant='outline'
                  onClick={async () => {
                    const picked = await pick()
                    if (picked) {
                      setPath(picked)
                      add.reset()
                    }
                  }}
                >
                  <FolderOpen />
                  {tr('选目录')}
                </Button>
              )}
            </div>
          </div>
          <div className='grid gap-1.5'>
            <label htmlFor='project-name' className='text-xs font-medium'>
              {tr('名字')}
              <span className='text-muted-foreground'>
                {tr('（可不填，默认用目录里认出来的名字）')}
              </span>
            </label>
            <Input
              id='project-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tr('从 package.json、README 等认出来')}
            />
          </div>
          {add.error && (
            <p className='text-xs text-danger'>{add.error.message}</p>
          )}
          <DialogFooter>
            <Button type='button' variant='ghost' onClick={() => close(false)}>
              {tr('取消')}
            </Button>
            <Button type='submit' disabled={!path.trim() || add.isPending}>
              {add.isPending && <LoaderCircle className='animate-spin' />}
              {tr('加为业务')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
