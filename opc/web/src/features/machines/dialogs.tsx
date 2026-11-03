import { useState } from 'react'
import { toast } from 'sonner'
import { useInviteMachine } from '@/lib/machine'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

/** 搜不到时手动填地址邀请 */
export function ManualInviteDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const invite = useInviteMachine()
  const [address, setAddress] = useState('')
  const close = () => {
    setAddress('')
    invite.reset()
    onClose()
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className='sm:max-w-sm'>
        <DialogHeader>
          <DialogTitle>手动邀请一台电脑</DialogTitle>
          <DialogDescription>
            填那台电脑的局域网地址。它要开着 HiveWard，屏幕上同意后才会加入。
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-3'
          onSubmit={(e) => {
            e.preventDefault()
            invite.mutate(
              { address: address.trim() },
              {
                onSuccess: (i) => {
                  toast.success(`已邀请「${i.machine.name}」，等对方同意`)
                  close()
                },
              }
            )
          }}
        >
          <Input
            autoFocus
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder='比如 192.168.1.23'
            className='font-mono'
          />
          {invite.isError && (
            <p className='text-xs text-danger'>{invite.error.message}</p>
          )}
          <DialogFooter>
            <button
              type='submit'
              disabled={!address.trim() || invite.isPending}
              className='h-8 w-full rounded-md bg-foreground text-xs text-background disabled:opacity-40'
            >
              {invite.isPending ? '正在邀请…' : '邀请加入组织'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function NameDialog({
  open,
  title,
  description,
  initial,
  onClose,
  onSave,
}: {
  open: boolean
  title: string
  description?: string
  initial: string
  onClose: () => void
  onSave: (name: string) => void
}) {
  const [name, setName] = useState(initial)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-sm'>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const next = name.trim()
            if (next && next !== initial) {
              onSave(next)
            }
            onClose()
          }}
          className='space-y-3'
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter>
            <button
              type='submit'
              disabled={!name.trim()}
              className='h-8 w-full rounded-md bg-foreground text-xs text-background disabled:opacity-40'
            >
              保存
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
