import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { Machine, MachineInvitation } from '@shared/api'
import { Laptop, LoaderCircle, MoreHorizontal, Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  useCurrentMachine,
  useInvitation,
  useInviteMachine,
  useLan,
  useRemoveMachine,
  useRefreshExitRegion,
  useRenameMachine,
  useRenameOrganization,
  useSwitchMachine,
} from '@/lib/machine'
import { timeAgo } from '@/lib/opc-format'
import { cn } from '@/lib/utils'
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
import { ExitRegionLine } from '@/components/opc/exit-region'
import { ShareSection } from './share-section'
import { platformName, spaced } from './verify-code'

/**
 * 局域网：打开了 HiveWard 的电脑会自动出现在「局域网里的电脑」里，不用配对码。
 * 点「加入组织」发邀请，对方屏幕上同意后两台就配对好了；组织里的电脑彼此平等，
 * 任意一台都能切到另一台，看它的 Agent、任务、待办、浏览器，也能直接对它的 Agent 说话。
 */
export function Machines() {
  const lan = useLan()
  const list = lan.data?.machines ?? []
  const org = lan.data?.organization ?? null
  const invitations = (lan.data?.invitations ?? []).filter(
    (i) => i.status === 'pending'
  )
  const members = list.filter((m) => m.self || m.paired)
  const nearby = list.filter((m) => !m.self && !m.paired)
  const [manual, setManual] = useState(false)

  return (
    <div className='mx-auto max-w-3xl space-y-8 p-5'>
      <OrgHeader
        name={org?.name}
        count={members.length}
        pendingRemovals={lan.data?.pendingRemovals ?? 0}
      />

      <section className='space-y-2'>
        <h2 className='flex h-7 items-center gap-2 px-1 text-[13px] font-medium'>
          组织里的电脑
          <span className='text-xs font-normal text-muted-foreground'>
            {members.length || ''}
          </span>
        </h2>
        {lan.isError ? (
          <p className='px-1 text-xs text-danger'>
            读取失败：{lan.error.message}
          </p>
        ) : (
          <ul className='divide-y rounded-xl panel'>
            {members.map((m) => (
              <MemberRow key={m.id} machine={m} />
            ))}
          </ul>
        )}
        <p className='px-1 text-[11px] leading-5 text-muted-foreground'>
          安全底线：Claude Code、Codex
          只在美国出口的电脑上开，出口测不出也不开。
          {list.find((m) => m.self)?.exitRegion?.limitation}
        </p>
      </section>

      <section className='space-y-2'>
        <header className='flex h-7 items-center gap-2 px-1'>
          <h2 className='text-[13px] font-medium'>局域网里的电脑</h2>
          <span className='flex items-center gap-1.5 text-xs text-muted-foreground'>
            <LoaderCircle className='size-3 animate-spin' />
            正在搜索
          </span>
          <button
            type='button'
            onClick={() => setManual(true)}
            className='ms-auto flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
          >
            <Plus className='size-3.5' /> 手动输入地址
          </button>
        </header>
        {nearby.length ? (
          <ul className='divide-y rounded-xl panel'>
            {nearby.map((m) => (
              <NearbyRow
                key={m.id}
                machine={m}
                invitation={invitations.find((i) => i.machine.id === m.id)}
              />
            ))}
          </ul>
        ) : (
          <p className='px-1 text-xs leading-5 text-muted-foreground'>
            还没搜到别的电脑。另一台电脑打开 HiveWard
            后会自动出现在这里；路由器不让设备互相发现时，用「手动输入地址」。
          </p>
        )}
      </section>

      <ShareSection />

      <ManualInviteDialog open={manual} onClose={() => setManual(false)} />
    </div>
  )
}

function OrgHeader({
  name,
  count,
  pendingRemovals,
}: {
  name?: string
  count: number
  pendingRemovals: number
}) {
  const rename = useRenameOrganization()
  const leave = useRemoveMachine()
  const [renaming, setRenaming] = useState(false)
  return (
    <div className='flex items-start gap-3 px-1'>
      <div className='min-w-0 flex-1'>
        <h1 className='truncate text-lg font-semibold'>
          {name ?? '还没有组织'}
        </h1>
        <p className='text-xs text-muted-foreground'>
          {name
            ? `${count} 台电脑，彼此能互相看、互相控制 Agent`
            : '邀请局域网里的第一台电脑时，会以这台电脑建一个组织'}
          {pendingRemovals > 0 && (
            <span className='text-attention'>
              {' '}
              · {pendingRemovals} 台离线电脑还没收到移出通知，上线后自动补发
            </span>
          )}
        </p>
      </div>
      {name && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label='组织设置'
            className='grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground'
          >
            <MoreHorizontal className='size-4' />
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='w-44'>
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              改组织名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant='destructive'
              onClick={() => {
                if (
                  !confirm(
                    '这台电脑退出组织？之后组织里的电脑都不能再控制这台，这台也不能再控制它们。'
                  )
                ) {
                  return
                }
                leave.mutate(null, {
                  onSuccess: () => toast.success('已退出组织'),
                  onError: (e) => toast.error(`没退出成功：${e.message}`),
                })
              }}
            >
              退出组织
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <NameDialog
        key={String(renaming)}
        open={renaming}
        title='改组织名'
        initial={name ?? ''}
        onClose={() => setRenaming(false)}
        onSave={(next) =>
          rename.mutate(next, {
            onError: (e) => toast.error(`没改成：${e.message}`),
          })
        }
      />
    </div>
  )
}

function MemberRow({ machine: m }: { machine: Machine }) {
  const current = useCurrentMachine()
  const switchTo = useSwitchMachine()
  const navigate = useNavigate()
  const remove = useRemoveMachine()
  const renameMachine = useRenameMachine()
  const refresh = useRefreshExitRegion()
  const [renaming, setRenaming] = useState(false)
  const viewing = current?.id === m.id
  const online = m.status === 'online'

  return (
    <li className='flex items-start gap-3 px-4 py-3'>
      <Laptop className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
      <div className='min-w-0 flex-1 space-y-1'>
        <div className='flex items-center gap-2'>
          <span className='truncate text-[13px] font-medium'>{m.name}</span>
          {m.self && (
            <span className='shrink-0 rounded bg-muted px-1.5 text-[11px] leading-4 text-muted-foreground'>
              本机
            </span>
          )}
          {m.platform && (
            <span className='shrink-0 text-[11px] text-muted-foreground'>
              {platformName(m.platform)}
            </span>
          )}
          {!m.self && m.secure === false && (
            <span
              title='和这台的通道没加密：对方还没升级，或证书对不上'
              className='shrink-0 rounded bg-danger/10 px-1.5 text-[11px] leading-4 text-danger'
            >
              未加密
            </span>
          )}
          <span
            className={cn(
              'flex shrink-0 items-center gap-1.5 text-xs',
              online ? 'text-live' : 'text-muted-foreground'
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                online ? 'bg-live' : 'bg-muted-foreground/40'
              )}
            />
            {online
              ? '在线'
              : `离线${m.lastSeenAt ? ` · ${timeAgo(m.lastSeenAt)}` : ''}`}
          </span>
        </div>
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
          <ExitRegionLine region={m.exitRegion} />
          {m.self && (
            <button
              type='button'
              disabled={refresh.isPending}
              onClick={() =>
                refresh.mutate(undefined, {
                  onError: (e) => toast.error(`没测成：${e.message}`),
                })
              }
              className='text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50'
            >
              {refresh.isPending ? '检测中…' : '重新检测'}
            </button>
          )}
        </div>
        {!m.self && m.error && (
          <p className='text-[11px] leading-4 text-danger'>
            {m.error.code === 'tls_rejoin_required'
              ? '这台是升级前加入的，通道没加密：先移出组织，两台都升级后重新邀请。'
              : m.error.code === 'tls_fingerprint_mismatch'
                ? '对方的证书和加入时记下的不一样，已拒绝连接。确认是同一台电脑后，移出再重新邀请。'
                : m.error.message}
          </p>
        )}
        {m.exitRegion?.warnings?.map((w) => (
          <p key={w.id} className='text-[11px] leading-4 text-danger'>
            {w.message}
          </p>
        ))}
        {m.summary ? (
          <p className='font-mono text-[11px] text-muted-foreground'>
            Agent {m.summary.agents} · 任务 {m.summary.tasksOpen} 进行中
            {m.summary.decisionsPending > 0 && (
              <span className='text-attention'>
                {' '}
                · 待决定 {m.summary.decisionsPending}
              </span>
            )}
            {!m.summary.orcaReachable && (
              <span className='text-danger'> · 引擎没开</span>
            )}
          </p>
        ) : (
          m.address && (
            <p className='font-mono text-[11px] text-muted-foreground'>
              {m.address}
            </p>
          )
        )}
      </div>

      <div className='flex shrink-0 items-center gap-1'>
        {viewing ? (
          <span className='px-2 text-xs text-muted-foreground'>正在看</span>
        ) : (
          <button
            type='button'
            disabled={!online && !m.self}
            onClick={async () => {
              await switchTo(m)
              navigate({ to: '/' })
            }}
            className='h-7 rounded-md px-2 text-xs hover:bg-accent disabled:opacity-50 disabled:hover:bg-transparent'
          >
            切过去看
          </button>
        )}
        {!m.self && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label='更多'
              className='flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent'
            >
              <MoreHorizontal className='size-4' />
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
              <DropdownMenuItem onClick={() => setRenaming(true)}>
                改名
              </DropdownMenuItem>
              <DropdownMenuItem
                variant='destructive'
                onClick={() => {
                  if (
                    !confirm(
                      `把「${m.name}」移出组织？之后两边都不能再互相控制。`
                    )
                  ) {
                    return
                  }
                  remove.mutate(m.id, {
                    onSuccess: (r) =>
                      toast.success(
                        r.pending
                          ? `已移出「${m.name}」，离线的电脑上线后会收到通知`
                          : `已移出「${m.name}」`
                      ),
                    onError: (e) => toast.error(`没移出成功：${e.message}`),
                  })
                }}
              >
                移出组织
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <NameDialog
        key={String(renaming)}
        open={renaming}
        title='给这台电脑改个名字'
        description='只改本机上显示的名字。'
        initial={m.name}
        onClose={() => setRenaming(false)}
        onSave={(name) =>
          renameMachine.mutate(
            { id: m.id, name },
            { onError: (e) => toast.error(`没改成：${e.message}`) }
          )
        }
      />
    </li>
  )
}

/** 搜到的一台电脑：加入组织 / 等对方同意（可撤回）/ 对方邀请了我（同意、拒绝） */
function NearbyRow({
  machine: m,
  invitation,
}: {
  machine: Machine
  invitation?: MachineInvitation
}) {
  const invite = useInviteMachine()
  const act = useInvitation()
  const incoming = invitation?.direction === 'incoming'
  const sent = invitation?.direction === 'sent'

  return (
    <li className='flex items-center gap-3 px-4 py-2.5'>
      <Laptop className='size-4 shrink-0 text-muted-foreground' />
      <span className='truncate text-[13px]'>{m.name}</span>
      {m.platform && (
        <span className='shrink-0 text-[11px] text-muted-foreground'>
          {platformName(m.platform)}
        </span>
      )}
      <span className='truncate font-mono text-xs text-muted-foreground'>
        {m.address}
      </span>
      <span className='ms-auto flex shrink-0 items-center gap-2'>
        {incoming ? (
          <>
            <span className='text-xs text-attention'>邀请你加入组织</span>
            <InviteButtons invitation={invitation} />
          </>
        ) : sent ? (
          <>
            <span className='flex items-center gap-1.5 text-xs text-muted-foreground'>
              <LoaderCircle className='size-3 animate-spin' />
              等对方同意
              {invitation.verifyCode && (
                <span title='对方屏幕上会显示同一串确认码'>
                  · 确认码{' '}
                  <span className='font-mono text-foreground'>
                    {spaced(invitation.verifyCode)}
                  </span>
                </span>
              )}
            </span>
            <button
              type='button'
              disabled={act.isPending}
              onClick={() =>
                act.mutate(
                  { id: invitation.id, action: 'cancel' },
                  { onError: (e) => toast.error(`没撤回：${e.message}`) }
                )
              }
              className='h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
            >
              撤回
            </button>
          </>
        ) : (
          <button
            type='button'
            disabled={invite.isPending}
            onClick={() =>
              invite.mutate(
                { machineId: m.id },
                {
                  onSuccess: () =>
                    toast.success(`已邀请「${m.name}」，等对方在屏幕上同意`),
                  onError: (e) => toast.error(`没邀请成功：${e.message}`),
                }
              )
            }
            className='h-7 rounded-md bg-foreground px-3 text-xs text-background disabled:opacity-50'
          >
            加入组织
          </button>
        )}
      </span>
    </li>
  )
}

/** 同意 / 拒绝收到的邀请；全局确认弹层和局域网页共用 */
export function InviteButtons({
  invitation,
  onDone,
}: {
  invitation: MachineInvitation
  onDone?: () => void
}) {
  const act = useInvitation()
  const run = (action: 'accept' | 'reject') =>
    act.mutate(
      { id: invitation.id, action },
      {
        onSuccess: () => {
          if (action === 'accept') {
            toast.success(`已加入「${invitation.organization.name}」`)
          }
          onDone?.()
        },
        onError: (e) => toast.error(`没处理成功：${e.message}`),
      }
    )
  return (
    <>
      <button
        type='button'
        disabled={act.isPending}
        onClick={() => run('reject')}
        className='h-7 rounded-md border px-3 text-xs hover:bg-accent disabled:opacity-50'
      >
        拒绝
      </button>
      <button
        type='button'
        disabled={act.isPending}
        onClick={() => run('accept')}
        className='h-7 rounded-md bg-foreground px-3 text-xs text-background disabled:opacity-50'
      >
        同意
      </button>
    </>
  )
}

/** 搜不到时手动填地址邀请 */
function ManualInviteDialog({
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

function NameDialog({
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
