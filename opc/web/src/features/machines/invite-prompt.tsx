import { useState } from 'react'
import { Laptop, TriangleAlert } from 'lucide-react'
import { useLan } from '@/lib/machine'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { InviteButtons } from './index'
import { spaced } from './verify-code'

/**
 * 别的电脑邀请这台加入组织：在哪个页面都弹出来让老板确认。
 * 同意就等于让对方能在这台电脑上开终端、跑 Agent，所以写清是谁、哪台、什么地址。
 * 「稍后」只是先关掉，局域网页里还能处理，邀请过期就没了。
 */
export function InvitePrompt() {
  const { data } = useLan()
  const [later, setLater] = useState<string[]>([])
  const invitation = data?.invitations?.find(
    (i) =>
      i.direction === 'incoming' &&
      i.status === 'pending' &&
      !later.includes(i.id)
  )
  if (!invitation) {
    return null
  }
  const m = invitation.machine
  const dismiss = () => setLater((l) => [...l, invitation.id])

  return (
    <Dialog open onOpenChange={(o) => !o && dismiss()}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>
            「{m.name}」邀请这台电脑加入「{invitation.organization.name}」
          </DialogTitle>
          <DialogDescription asChild>
            <div className='space-y-3 pt-1'>
              <p className='flex items-center gap-2 font-mono text-xs'>
                <Laptop className='size-3.5 shrink-0' />
                {m.name}
                {m.user && ` · ${m.user}`} · {m.address}
              </p>
              {invitation.verifyCode && (
                <div className='rounded-md border px-3 py-2.5 text-center'>
                  <p className='text-[11px] text-muted-foreground'>确认码</p>
                  <p className='mt-1 font-mono text-2xl tracking-[0.3em] text-foreground'>
                    {spaced(invitation.verifyCode)}
                  </p>
                  <p className='mt-1 text-[11px] text-muted-foreground'>
                    和「{m.name}」屏幕上显示的一样才同意，不一样就拒绝
                  </p>
                </div>
              )}
              <p className='flex gap-2 rounded-md bg-attention/10 px-3 py-2 text-xs leading-5 text-attention'>
                <TriangleAlert className='mt-0.5 size-3.5 shrink-0' />
                同意后，组织里的电脑都能在这台电脑上开终端、跑命令、控制
                Agent。不认识这台电脑就拒绝。
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className='flex justify-end gap-2'>
          <button
            type='button'
            onClick={dismiss}
            className='h-7 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
          >
            稍后
          </button>
          <InviteButtons invitation={invitation} onDone={dismiss} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
