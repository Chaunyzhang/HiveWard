import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { Machine, MachineInvitation } from '@shared/api'
import { Laptop, LoaderCircle, Monitor, MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { timeAgo } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import {
  useCurrentMachine,
  useInvitation,
  useInviteMachine,
  useRemoveMachine,
  useRenameMachine,
  useSwitchMachine,
} from '@/lib/machine'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ExitRegionLine } from '@/components/hiveward/exit-region'
import { NameDialog } from './dialogs'
import { platformName, spaced } from './verify-code'

const primary =
  'h-8 rounded-md bg-foreground px-3 text-xs text-background disabled:opacity-50'
const secondary =
  'h-8 rounded-md border px-3 text-xs hover:bg-accent disabled:opacity-50'

/**
 * 局域网页的一张电脑卡片：本机、组织里的电脑、局域网里还没加入的电脑都用它。
 * 组织里的点卡片进它的「传输」页，也能切过去看；没加入的能邀请；
 * 有待处理的邀请 / 申请时在卡片底部核对确认码、同意或撤回。
 */
export function MachineCard({
  machine: m,
  member,
  invitation,
}: {
  machine: Machine
  member: boolean
  invitation?: MachineInvitation
}) {
  const online = m.self || m.status === 'online'
  const Icon = m.platform === 'win32' ? Monitor : Laptop
  // 组织里别的电脑整张卡能点，进传输页给它传文件（本机不用给自己传）；卡上的按钮浮在上面照常点
  const transfer = member && online && !m.self
  return (
    <div
      className={cn(
        'relative flex min-h-40 flex-col rounded-xl border bg-card p-4',
        transfer &&
          'transition-colors hover:bg-accent/40 [&_button]:relative [&_button]:z-10'
      )}
    >
      {transfer && (
        <Link
          to='/machines/$machineId'
          params={{ machineId: m.id }}
          aria-label={tr('给「{0}」传文件', [m.name])}
          title={tr('点进去传文件')}
          className='absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring'
        />
      )}
      <div className='flex items-start gap-2.5'>
        <Icon className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
        <div className='min-w-0 flex-1'>
          <p className='truncate text-[14px] font-medium'>{m.name}</p>
          <p className='mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground'>
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                online ? 'bg-live' : 'bg-muted-foreground/40'
              )}
            />
            {online
              ? tr('在线')
              : tr('离线{0}', [
                  m.lastSeenAt ? ` · ${timeAgo(m.lastSeenAt)}` : '',
                ])}
            {m.platform && <> · {platformName(m.platform)}</>}
            {m.self && <> {tr('· 本机')}</>}
          </p>
        </div>
        {member && !m.self && <MemberMenu machine={m} />}
      </div>

      <div className='mt-3 flex-1 space-y-1 text-xs text-muted-foreground'>
        {member ? <MemberDetail machine={m} /> : <NearbyDetail machine={m} />}
      </div>

      <div className='mt-4 flex flex-wrap items-center gap-2'>
        {invitation ? (
          <InvitationActions invitation={invitation} />
        ) : member ? (
          <ViewButton machine={m} />
        ) : (
          <InviteButton machine={m} />
        )}
      </div>
    </div>
  )
}

function MemberDetail({ machine: m }: { machine: Machine }) {
  return (
    <>
      {m.summary && (
        <p className='font-mono text-[11px]'>
          {tr('Agent {0} · 任务 {1} 进行中', [
            m.summary.agents,
            m.summary.tasksOpen,
          ])}
          {m.summary.decisionsPending > 0 && (
            <span className='text-attention'>
              {tr('· 待决定 {0}', [m.summary.decisionsPending])}
            </span>
          )}
          {!m.summary.hivewardReachable && (
            <span className='text-danger'> {tr('· 引擎没开')}</span>
          )}
        </p>
      )}
      <ExitRegionLine region={m.exitRegion} />
      {!m.self && m.secure === false && (
        <p className='text-danger'>
          {tr('通道没加密：对方还没升级，或证书对不上')}
        </p>
      )}
      {!m.self && m.error && (
        <p className='text-danger'>
          {m.error.code === 'tls_rejoin_required'
            ? tr('这台是升级前加入的：先移出组织，两台都升级后重新邀请。')
            : m.error.code === 'tls_fingerprint_mismatch'
              ? tr(
                  '对方的证书和加入时记下的不一样，已拒绝连接。确认是同一台后移出再重新邀请。'
                )
              : m.error.message}
        </p>
      )}
    </>
  )
}

function NearbyDetail({ machine: m }: { machine: Machine }) {
  return (
    <>
      <p>
        {m.organization
          ? tr('在「{0}」{1}', [
              m.organization.name,
              m.organization.members > 1
                ? tr(' · {0} 台', [m.organization.members])
                : '',
            ])
          : tr('还没加入组织')}
      </p>
      {m.address && <p className='font-mono text-[11px]'>{m.address}</p>}
    </>
  )
}

function ViewButton({ machine: m }: { machine: Machine }) {
  const current = useCurrentMachine()
  const switchTo = useSwitchMachine()
  const navigate = useNavigate()
  if (current?.id === m.id) {
    return <span className='text-xs text-muted-foreground'>{tr('正在看')}</span>
  }
  return (
    <button
      type='button'
      disabled={!m.self && m.status !== 'online'}
      onClick={async () => {
        await switchTo(m)
        void navigate({ to: '/' })
      }}
      className={secondary}
    >
      {tr('切过去看')}
    </button>
  )
}

function InviteButton({ machine: m }: { machine: Machine }) {
  const invite = useInviteMachine()
  return (
    <button
      type='button'
      disabled={invite.isPending}
      onClick={() =>
        invite.mutate(
          { machineId: m.id },
          {
            onSuccess: () =>
              toast.success(tr('已邀请「{0}」，等对方在屏幕上同意', [m.name])),
            onError: (e) => toast.error(tr('没邀请成功：{0}', [e.message])),
          }
        )
      }
      className={primary}
    >
      {tr('邀请加入')}
    </button>
  )
}

/** 卡片底部：确认码 + 同意 / 拒绝（对方发起的）或 撤回（本机发起的） */
function InvitationActions({
  invitation: i,
}: {
  invitation: MachineInvitation
}) {
  const act = useInvitation()
  const request = i.kind === 'request'
  const label =
    i.direction === 'incoming'
      ? request
        ? tr('申请加入你的组织')
        : tr('邀请你加入「{0}」', [i.organization.name])
      : request
        ? tr('已申请加入「{0}」', [i.organization.name])
        : tr('已邀请，等对方同意')
  return (
    <div className='w-full space-y-2'>
      <p
        className={cn(
          'flex items-center gap-1.5 text-xs',
          i.direction === 'incoming'
            ? 'text-attention'
            : 'text-muted-foreground'
        )}
      >
        {i.direction === 'sent' && (
          <LoaderCircle className='size-3 animate-spin' />
        )}
        {label}
      </p>
      {i.verifyCode && (
        <p
          title={tr('两台电脑屏幕上的确认码一样，才是真的那台')}
          className='text-xs text-muted-foreground'
        >
          {tr('确认码')}
          <span className='font-mono text-[15px] tracking-widest text-foreground'>
            {spaced(i.verifyCode)}
          </span>
        </p>
      )}
      <div className='flex gap-2'>
        {i.direction === 'incoming' ? (
          <InviteButtons invitation={i} />
        ) : (
          <button
            type='button'
            disabled={act.isPending}
            onClick={() =>
              act.mutate(
                { id: i.id, action: 'cancel' },
                { onError: (e) => toast.error(tr('没撤回：{0}', [e.message])) }
              )
            }
            className={secondary}
          >
            {tr('撤回')}
          </button>
        )}
      </div>
    </div>
  )
}

/** 同意 / 拒绝收到的邀请或申请；全局确认弹层和局域网页共用 */
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
            toast.success(
              invitation.kind === 'request'
                ? tr('「{0}」已加入组织', [invitation.machine.name])
                : tr('已加入「{0}」', [invitation.organization.name])
            )
          }
          onDone?.()
        },
        onError: (e) => toast.error(tr('没处理成功：{0}', [e.message])),
      }
    )
  return (
    <>
      <button
        type='button'
        disabled={act.isPending}
        onClick={() => run('reject')}
        className={secondary}
      >
        {tr('拒绝')}
      </button>
      <button
        type='button'
        disabled={act.isPending}
        onClick={() => run('accept')}
        className={primary}
      >
        {tr('同意')}
      </button>
    </>
  )
}

function MemberMenu({ machine: m }: { machine: Machine }) {
  const remove = useRemoveMachine()
  const renameMachine = useRenameMachine()
  const [renaming, setRenaming] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={tr('更多')}
          className='grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent'
        >
          <MoreHorizontal className='size-4' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            {tr('改名')}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant='destructive'
            onClick={() => {
              if (
                !confirm(
                  tr('把「{0}」移出组织？之后两边都不能再互相控制。', [m.name])
                )
              ) {
                return
              }
              remove.mutate(m.id, {
                onSuccess: (r) =>
                  toast.success(
                    r.pending
                      ? tr('已移出「{0}」，离线的电脑上线后会收到通知', [
                          m.name,
                        ])
                      : tr('已移出「{0}」', [m.name])
                  ),
                onError: (e) => toast.error(tr('没移出成功：{0}', [e.message])),
              })
            }}
          >
            {tr('移出组织')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog
        key={String(renaming)}
        open={renaming}
        title={tr('给这台电脑改个名字')}
        description={tr('只改本机上显示的名字。')}
        initial={m.name}
        onClose={() => setRenaming(false)}
        onSave={(name) =>
          renameMachine.mutate(
            { id: m.id, name },
            { onError: (e) => toast.error(tr('没改成：{0}', [e.message])) }
          )
        }
      />
    </>
  )
}
