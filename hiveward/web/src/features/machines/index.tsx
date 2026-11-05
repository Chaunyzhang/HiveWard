import { useState } from 'react'
import type {
  Machine,
  MachineDiscoveryStatus,
  MachineInvitation,
} from '@shared/api'
import { Check, ChevronDown, LoaderCircle, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { tr } from '@/lib/i18n'
import {
  useLan,
  useRemoveMachine,
  useRenameOrganization,
  useRequestJoin,
} from '@/lib/machine'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Page } from '@/components/layout/page'
import { ManualInviteDialog, NameDialog } from './dialogs'
import { MachineCard } from './machine-card'

/**
 * 局域网：标题就是本机所在的组织（默认以本机建），点开能切到局域网里的别的组织（申请加入）。
 * 下面两块：「组织里的电脑」（本机 + 已加入的），「局域网里的电脑」只列还没加入组织的别的电脑。能邀请别的电脑加入，
 * 别的电脑也能申请加入，这边同意；两边屏幕核对同一个确认码。
 * 点组织里的某台电脑，进它的「传输」页选文件、传文件。
 * 设置（共享、剪贴板、MCP）在「设置」里。
 */
export function Machines() {
  const lan = useLan()
  const list = lan.data?.machines ?? []
  const self = list.find((m) => m.self)
  const invitations = (lan.data?.invitations ?? []).filter(
    (i) => i.status === 'pending'
  )
  const members = list.filter((m) => m.self || m.paired)
  const nearby = list.filter((m) => !m.self && !m.paired)
  const pendingOf = (m: Machine) =>
    invitations.find((i) => i.machine.id === m.id)
  // 有待处理的邀请 / 申请的排前面
  const sortedNearby = [...nearby].sort(
    (a, b) => Number(!!pendingOf(b)) - Number(!!pendingOf(a))
  )
  const [manual, setManual] = useState(false)

  return (
    <Page>
      <OrgHeader
        name={
          lan.data?.organization?.name ??
          (self ? tr('{0}的组织', [self.name]) : tr('我的组织'))
        }
        orgId={lan.data?.organization?.id}
        count={members.length}
        nearby={nearby}
        pendingRemovals={lan.data?.pendingRemovals ?? 0}
      />

      {lan.isError ? (
        <p className='mt-8 text-xs text-danger'>
          {tr('读取失败：{0}', [lan.error.message])}
        </p>
      ) : (
        <>
          <header className='mt-8 mb-3 flex items-center gap-2'>
            <h2 className='text-[15px] font-semibold'>{tr('组织里的电脑')}</h2>
            <span className='text-xs text-muted-foreground'>
              {tr('点一台看它的文件、给它传文件')}
            </span>
          </header>
          <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
            {members.map((m) => (
              <MachineCard
                key={m.id}
                machine={m}
                member
                invitation={pendingOf(m)}
              />
            ))}
          </div>

          <header className='mt-8 mb-3 flex items-center gap-2'>
            <h2 className='text-[15px] font-semibold'>
              {tr('局域网里的电脑')}
            </h2>
            <span className='flex items-center gap-1.5 text-xs text-muted-foreground'>
              <LoaderCircle className='size-3 animate-spin' />
              {tr('正在搜索还没加入组织的电脑')}
            </span>
          </header>
          <DiscoveryWarning
            status={lan.data?.discovery}
            platform={self?.platform}
          />
          <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
            {sortedNearby.map((m) => (
              <MachineCard
                key={m.id}
                machine={m}
                member={false}
                invitation={pendingOf(m)}
              />
            ))}
            <OrphanInvitations
              invitations={invitations.filter(
                (i) => !list.some((m) => m.id === i.machine.id)
              )}
            />
            <button
              type='button'
              onClick={() => setManual(true)}
              className='flex min-h-40 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
            >
              <Plus className='size-4' />
              {tr('手动输入地址邀请')}
              <span className='text-[11px]'>
                {tr('路由器不让设备互相发现时用')}
              </span>
            </button>
          </div>
        </>
      )}

      <ManualInviteDialog open={manual} onClose={() => setManual(false)} />
    </Page>
  )
}

/** 发现发不出去、端口没占上时说清楚为什么搜不到、去哪儿打开 */
function DiscoveryWarning({
  status,
  platform,
}: {
  status: MachineDiscoveryStatus | null | undefined
  platform: Machine['platform']
}) {
  if (!status) {
    return null
  }
  if (status.listening && !status.blocked) {
    return null
  }
  const reason = status.listening
    ? tr('本机发不出局域网广播（{0}）', [status.sendError ?? '?'])
    : tr('局域网发现端口没占上（{0}）', [status.bindError ?? '?'])
  const fix =
    platform === 'darwin'
      ? tr(
          '打开「系统设置 → 隐私与安全性 → 本地网络」，把 HiveWard 打开，再重开 HiveWard。'
        )
      : platform === 'win32'
        ? tr(
            '在「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」里勾上 HiveWard 的「专用」网络，再重开 HiveWard。'
          )
        : tr('检查防火墙是否放行 HiveWard，再重开 HiveWard。')
  return (
    <p className='mb-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger'>
      {reason}
      {tr('，别的电脑搜不到这台，这台也搜不到别的。')}
      {fix}
    </p>
  )
}

/** 手动填地址发出的邀请 / 收到的申请，对方不在发现列表里时也要能看到、能处理 */
function OrphanInvitations({
  invitations,
}: {
  invitations: MachineInvitation[]
}) {
  return invitations.map((i) => (
    <MachineCard
      key={i.id}
      machine={{
        id: i.machine.id,
        name: i.machine.name,
        self: false,
        paired: false,
        exitRegion: null,
        discovered: false,
        invite: i.direction,
        status: 'online',
        address: i.machine.address,
      }}
      member={false}
      invitation={i}
    />
  ))
}

/** 标题 = 组织名，点开：本机所在的组织、局域网里别的组织（申请加入）、改名、退出 */
function OrgHeader({
  name,
  orgId,
  count,
  nearby,
  pendingRemovals,
}: {
  name: string
  orgId?: string
  count: number
  nearby: Machine[]
  pendingRemovals: number
}) {
  const rename = useRenameOrganization()
  const leave = useRemoveMachine()
  const join = useRequestJoin()
  const [renaming, setRenaming] = useState(false)
  // 局域网里别的组织：按组织 id 合并，申请时找它一台在线的电脑发过去
  const others = [
    ...new Map(
      nearby
        .filter((m) => m.organization && m.organization.id !== orgId)
        .map((m) => [m.organization!.id, { org: m.organization!, via: m }])
    ).values(),
  ]

  return (
    <div>
      <DropdownMenu>
        <DropdownMenuTrigger className='-ms-2 flex max-w-full items-center gap-1.5 rounded-md px-2 outline-none hover:bg-accent'>
          <h1 className='truncate text-lg font-semibold'>{name}</h1>
          <ChevronDown className='size-4 shrink-0 text-muted-foreground' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='w-72'>
          <DropdownMenuLabel className='text-xs font-normal text-muted-foreground'>
            {tr('这台电脑所在的组织')}
          </DropdownMenuLabel>
          <DropdownMenuItem className='justify-between'>
            <span className='truncate'>{name}</span>
            <span className='flex shrink-0 items-center gap-2 text-xs text-muted-foreground'>
              {tr('{0} 台', [count])}
              <Check className='size-4' />
            </span>
          </DropdownMenuItem>
          {others.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className='text-xs font-normal text-muted-foreground'>
                {tr('局域网里的其他组织：选一个申请加入')}
              </DropdownMenuLabel>
              {others.map(({ org, via }) => (
                <DropdownMenuItem
                  key={org.id}
                  className='justify-between'
                  onClick={() => {
                    if (
                      !confirm(
                        tr(
                          '申请加入「{0}」？对方同意后，这台会离开「{1}」，和「{2}」里的电脑互相能看、能控制 Agent。',
                          [org.name, name, org.name]
                        )
                      )
                    ) {
                      return
                    }
                    join.mutate(
                      { machineId: via.id },
                      {
                        onSuccess: () =>
                          toast.success(
                            tr('已申请加入「{0}」，等对方在屏幕上同意', [
                              org.name,
                            ])
                          ),
                        onError: (e) =>
                          toast.error(tr('没申请成功：{0}', [e.message])),
                      }
                    )
                  }}
                >
                  <span className='truncate'>{org.name}</span>
                  <span className='shrink-0 text-xs text-muted-foreground'>
                    {tr('{0} 台 · 申请加入', [org.members])}
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!orgId} onClick={() => setRenaming(true)}>
            {tr('改组织名')}
          </DropdownMenuItem>
          {count > 1 && (
            <DropdownMenuItem
              variant='destructive'
              onClick={() => {
                if (
                  !confirm(
                    tr(
                      '这台电脑退出组织？之后组织里的电脑都不能再控制这台，这台也不能再控制它们。'
                    )
                  )
                ) {
                  return
                }
                leave.mutate(null, {
                  onSuccess: () => toast.success(tr('已退出组织')),
                  onError: (e) =>
                    toast.error(tr('没退出成功：{0}', [e.message])),
                })
              }}
            >
              {tr('退出组织')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <p className='mt-1 text-[13px] text-muted-foreground'>
        {count > 1
          ? tr('{0} 台电脑，彼此能互相看、互相控制 Agent', [count])
          : tr('只有这台电脑。邀请局域网里的电脑加入，或者让它们申请加入。')}
        {pendingRemovals > 0 && (
          <span className='text-attention'>
            {tr('· {0} 台离线电脑还没收到移出通知，上线后自动补发', [
              pendingRemovals,
            ])}
          </span>
        )}
      </p>
      <NameDialog
        key={String(renaming)}
        open={renaming}
        title={tr('改组织名')}
        initial={name}
        onClose={() => setRenaming(false)}
        onSave={(next) =>
          rename.mutate(next, {
            onError: (e) => toast.error(tr('没改成：{0}', [e.message])),
          })
        }
      />
    </div>
  )
}
