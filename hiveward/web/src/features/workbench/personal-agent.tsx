import { useState } from 'react'
import type {
  BusinessSummary,
  Harness,
  PersonalAgentId,
  Task,
  TopologyNode,
} from '@shared/api'
import { toast } from 'sonner'
import { useGrokBots } from '@/lib/grok'
import { useHarnesses, useUpdateBusiness } from '@/lib/hiveward-api'
import { timeAgo } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { AgentLogo } from '@/components/hiveward/agent-logo'
import { GrokBotAvatar } from '@/components/hiveward/grokbot-avatar'
import { PaneHeader } from '@/components/layout/top-bar-slot'
import { GrokProfile } from './grok-profile'

/**
 * 点架构图上的 Personal Agent 位：空着时在这儿选一家（只列 Personal Agent，Coding Agent 在 CEO / Leader 位上选）；
 * 坐着 Grok Bot 时是它的主页，坐着别家时是它的资料。都能「换一个」。
 */
export function PersonalAgentPane({
  node,
  business,
  tasks,
  leading,
  trailing,
}: {
  node: TopologyNode
  business?: BusinessSummary
  tasks: Task[]
  leading?: React.ReactNode
  trailing?: React.ReactNode
}) {
  const [picking, setPicking] = useState(false)
  const change = (
    <button
      type='button'
      onClick={() => setPicking(true)}
      className='h-7 shrink-0 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
    >
      {tr('换一个')}
    </button>
  )
  const tools = (
    <div className='ms-auto flex items-center gap-1'>
      {node.agent && !picking && change}
      {trailing}
    </div>
  )
  if (node.agent === 'grokbot' && node.bot && !picking) {
    return (
      <GrokProfile
        leading={leading}
        trailing={tools}
        tasks={tasks}
        botId={node.bot}
      />
    )
  }
  return (
    <div className='flex h-full min-h-0 flex-col'>
      <PaneHeader className='gap-1'>
        {leading}
        <span className='truncate text-[13px] font-medium'>
          {node.agent && !picking ? node.label : 'Personal Agent'}
        </span>
        {tools}
      </PaneHeader>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        {node.agent === 'grokbot' && !picking ? (
          <BotPicker business={business} current={node.bot} />
        ) : node.agent && !picking ? (
          <Occupant id={node.agent} />
        ) : (
          <Picker
            business={business}
            current={node.agent}
            onDone={() => setPicking(false)}
          />
        )}
      </div>
    </div>
  )
}

/** 坐着的是 Grok Bot 以外的那几家：HiveWard 还读不到它们的对话，只给资料 */
function Occupant({ id }: { id: string }) {
  const h = useHarnesses().data?.personal.find((x) => x.id === id)
  return (
    <div className='mx-auto flex max-w-md flex-col items-center px-6 pt-12 text-center'>
      <AgentLogo agent={id} className='size-20' />
      <h1 className='mt-5 text-2xl font-semibold'>{h?.name ?? id}</h1>
      {h && <HarnessMeta h={h} className='mt-1.5 justify-center' />}
      <p className='mt-6 text-xs leading-5 text-muted-foreground'>
        {tr('HiveWard 还读不到 {0} 里的对话，要跟它说话请回 {1}。', [
          h?.name ?? id,
          h?.name ?? id,
        ])}
      </p>
    </div>
  )
}

function Picker({
  business,
  current,
  onDone,
}: {
  business?: BusinessSummary
  current?: string
  onDone: () => void
}) {
  const { data, error, isLoading } = useHarnesses()
  const update = useUpdateBusiness()
  const [step, setStep] = useState<'grokbot' | null>(null)
  if (!business) {
    return (
      <p className='p-8 text-[13px] text-muted-foreground'>
        {tr('这块业务还没登记，没有 Personal Agent 位。')}
      </p>
    )
  }
  const choose = (personalAgent: PersonalAgentId | null) =>
    update.mutate(
      { id: business.id, personalAgent },
      {
        onSuccess: () => {
          toast.success(
            personalAgent
              ? tr('Personal Agent 换好了')
              : tr('Personal Agent 位空出来了')
          )
          onDone()
        },
        onError: (e) => toast.error(tr('没换成：{0}', [e.message])),
      }
    )
  const list = data?.personal ?? []
  if (step === 'grokbot') {
    return (
      <BotPicker
        business={business}
        onBack={() => setStep(null)}
        onDone={onDone}
      />
    )
  }
  return (
    <div className='mx-auto w-full max-w-lg px-6 py-10'>
      <h1 className='text-lg font-semibold'>
        {tr('给「{0}」选一个 Personal Agent', [business.name])}
      </h1>
      <p className='mt-1.5 text-xs leading-5 text-muted-foreground'>
        {tr(
          'Personal Agent 是常驻的 AI 同事，帮你盯着这块业务、给 Agent 派活。这里只列 Personal Agent；CEO、Leader、下属坐的是 Coding Agent，在它们的座位上选。'
        )}
      </p>
      {isLoading ? (
        <p className='mt-6 text-[13px] text-muted-foreground'>
          {tr('正在看这台电脑装了哪些…')}
        </p>
      ) : error ? (
        <p className='mt-6 text-[13px] text-danger'>
          {tr('没认出来：{0}', [error.message])}
        </p>
      ) : (
        <div className='mt-6 space-y-2'>
          {list.map((h) => (
            <button
              key={h.id}
              type='button'
              disabled={!h.installed || update.isPending}
              // Grok Bot 里有好几个 Bot：先选产品，再选用哪一个
              onClick={() =>
                h.id === 'grokbot' ? setStep('grokbot') : choose(h.id)
              }
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-start hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                h.id === current && 'border-ring bg-accent'
              )}
            >
              <AgentLogo agent={h.id} className='size-8' />
              <span className='min-w-0 flex-1'>
                <span className='block text-[13px] font-medium'>
                  {h.name}
                  {h.id === current && (
                    <span className='ms-2 text-xs font-normal text-muted-foreground'>
                      {tr('现在坐着')}
                    </span>
                  )}
                </span>
                <HarnessMeta h={h} />
              </span>
            </button>
          ))}
          {current && (
            <button
              type='button'
              disabled={update.isPending}
              onClick={() => choose(null)}
              className='mt-2 h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
            >
              {tr('空出这个位置')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 做它的公司、装没装、版本、App 或命令行 */
export function HarnessMeta({
  h,
  className,
}: {
  h: Harness
  className?: string
}) {
  const bits = h.installed
    ? [
        h.maker,
        h.version && `v${h.version}`,
        h.app ? tr('桌面 App') : undefined,
        h.command && tr('命令行 {0}', [h.command]),
      ]
    : [h.maker, tr('这台电脑没装')]
  return (
    <span
      className={cn(
        'flex flex-wrap gap-x-1.5 text-xs text-muted-foreground',
        className
      )}
    >
      {bits.filter(Boolean).join(' · ')}
    </span>
  )
}

/**
 * Grok Bot 里有好几个 Bot：选了 Grok Bot 这个产品之后，再选让哪一个 Bot 当这块业务的 Personal Agent。
 */
function BotPicker({
  business,
  current,
  onBack,
  onDone,
}: {
  business?: BusinessSummary
  current?: string
  /** 从「选哪家」那一步过来的：可以退回去 */
  onBack?: () => void
  onDone?: () => void
}) {
  const { data, error, isLoading } = useGrokBots()
  const update = useUpdateBusiness()
  if (!business) {
    return null
  }
  const bots = data?.bots ?? []
  const choose = (bot: string) =>
    update.mutate(
      { id: business.id, personalAgent: 'grokbot', personalAgentBot: bot },
      {
        onSuccess: () => {
          toast.success(tr('Personal Agent 选好了'))
          onDone?.()
        },
        onError: (e) => toast.error(tr('没选成：{0}', [e.message])),
      }
    )
  return (
    <div className='mx-auto w-full max-w-lg px-6 py-10'>
      <h1 className='text-lg font-semibold'>
        {tr('选 Grok Bot 里的哪个 Bot 当「{0}」的 Personal Agent', [
          business.name,
        ])}
      </h1>
      <p className='mt-1.5 text-xs leading-5 text-muted-foreground'>
        {tr(
          'Grok Bot 里可以有好几个 Bot，各自有自己的记忆和对话。选一个常驻这块业务。'
        )}
      </p>
      {isLoading ? (
        <p className='mt-6 text-[13px] text-muted-foreground'>
          {tr('读取 Grok Bot…')}
        </p>
      ) : error ? (
        <p className='mt-6 text-[13px] text-danger'>
          {tr('读不到 Grok Bot：{0}', [error.message])}
        </p>
      ) : bots.length === 0 ? (
        <p className='mt-6 text-[13px] text-muted-foreground'>
          {tr('Grok Bot 里还没有 Bot{0}，先在 Grok Bot 里建一个。', [
            data?.signedIn ? '' : tr('（还没登录）'),
          ])}
        </p>
      ) : (
        <div className='mt-6 space-y-2'>
          {bots.map((b) => (
            <button
              key={b.id}
              type='button'
              disabled={update.isPending}
              onClick={() => choose(b.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-start hover:bg-accent disabled:opacity-50',
                b.id === current && 'border-ring bg-accent'
              )}
            >
              <GrokBotAvatar seed={b.id} look={b} className='size-9' />
              <span className='min-w-0 flex-1'>
                <span className='block text-[13px] font-medium'>
                  {b.name}
                  {b.id === current && (
                    <span className='ms-2 text-xs font-normal text-muted-foreground'>
                      {tr('现在坐着')}
                    </span>
                  )}
                </span>
                {b.lastActivityAt && (
                  <span className='text-xs text-muted-foreground'>
                    {tr('{0}有动静', [timeAgo(b.lastActivityAt)])}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      {onBack && (
        <button
          type='button'
          onClick={onBack}
          className='mt-4 h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
        >
          {tr('← 换别家')}
        </button>
      )}
    </div>
  )
}
