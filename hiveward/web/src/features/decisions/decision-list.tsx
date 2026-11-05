import { useState } from 'react'
import type { BusinessSummary, Decision } from '@shared/api'
import { toast } from 'sonner'
import {
  useDecisions,
  useOverview,
  useResolveDecision,
} from '@/lib/hiveward-api'
import { timeAgo, urgencyStyle } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { scoped, useMachineId } from '@/lib/machine'
import { cn } from '@/lib/utils'
import { FREE_KEY, QuestionCard } from '@/components/hiveward/question-card'
import { useOpenSession } from '@/features/workbench/open-session'

/**
 * 待决策：Agent 问你的事，一件一张提问卡片，和对话页里 Agent 提问时同一个样子
 * （问题、竖排选项带说明、推荐标签、最后一行自己写）。紧急的排前面。
 */
export function DecisionList({
  businessId,
  match,
}: {
  businessId?: string
  /** 再筛一道（项目主页只看这个项目里 Agent 问的） */
  match?: (d: Decision) => boolean
}) {
  const { data: decisions = [] } = useDecisions()
  const { data: overview } = useOverview()
  const pending = decisions
    .filter((d) => d.state === 'pending')
    .filter((d) => !businessId || d.businessId === businessId)
    .filter((d) => !match || match(d))
    .sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt))

  if (pending.length === 0) {
    return (
      <p className='px-2 py-6 text-[13px] text-muted-foreground'>
        {tr('没有待决策的事。')}
      </p>
    )
  }

  return (
    <div className='space-y-3'>
      {pending.map((d) => (
        <DecisionCard
          key={d.id}
          decision={d}
          business={overview?.businesses.find((b) => b.id === d.businessId)}
          // 只有一件时数字键直接选；好几件时按哪张不清楚，就只能点
          hotkeys={pending.length === 1}
        />
      ))}
    </div>
  )
}

export function DecisionCard({
  decision: d,
  business: b,
  hotkeys,
  className,
  inSession,
}: {
  decision: Decision
  business?: BusinessSummary
  hotkeys: boolean
  className?: string
  /** 已经在它的对话页里：不再给「去对话页」 */
  inSession?: boolean
}) {
  const openSession = useOpenSession()
  const resolve = useResolveDecision()
  const machine = useMachineId()
  const [picked, setPicked] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  // 终端菜单：选项就是菜单那几项；菜单上有「自己写」那项才能自己写
  const menu = !!d.dispatch?.menu
  const canWrite = !menu || !!d.dispatch?.free

  const send = (choice: string, custom?: boolean) => {
    if (resolve.isPending) {
      return
    }
    setPicked(custom ? FREE_KEY : choice)
    resolve.mutate(
      { id: d.id, choice, custom },
      {
        onSuccess: () =>
          toast.success(
            custom ? tr('已把你的话发回去') : tr('已选：{0}', [choice])
          ),
        onError: (e) => {
          setPicked(null)
          toast.error(tr('没发出去：{0}', [e.message]))
        },
      }
    )
  }

  return (
    <QuestionCard
      className={className}
      meta={
        <>
          <span
            className={cn(
              'me-1.5 inline-block size-1.5 rounded-full align-middle',
              urgencyStyle[d.urgency].dot
            )}
          />
          {[
            b?.name,
            !inSession &&
              d.dispatch?.by &&
              tr('{0}派的 Agent', [d.dispatch.by]),
            urgencyStyle[d.urgency].label,
            timeAgo(d.createdAt),
          ]
            .filter(Boolean)
            .join(' · ')}
          {!inSession && d.dispatch?.handle && (
            <button
              type='button'
              onClick={() =>
                openSession({
                  terminal: d.dispatch!.handle,
                  businessId: d.businessId,
                })
              }
              className='ms-2 text-brand hover:underline'
            >
              {tr('去对话页 ›')}
            </button>
          )}
        </>
      }
      title={d.title}
      question={d.question}
      body={
        (d.body || d.screenshot) && (
          <div className='mt-1.5 space-y-2'>
            {d.body && (
              <button
                type='button'
                onClick={() => setMore(!more)}
                className={cn(
                  'block text-start text-[13px] leading-5 wrap-anywhere whitespace-pre-wrap text-muted-foreground',
                  !more && 'line-clamp-3'
                )}
              >
                {d.body}
              </button>
            )}
            {d.screenshot && (
              <a
                href={scoped(d.screenshot, machine)}
                target='_blank'
                rel='noreferrer'
                title={tr('看大图')}
              >
                <img
                  src={scoped(d.screenshot, machine)}
                  alt={tr('Agent 附的截图')}
                  className='max-h-64 w-full rounded-lg border object-cover object-top'
                />
              </a>
            )}
          </div>
        )
      }
      options={d.options.map((label) => ({
        key: label,
        label,
        description: d.optionDescriptions?.[label],
        recommended: label === d.recommendation,
      }))}
      freeText={
        canWrite
          ? menu
            ? tr('都不是，自己写…')
            : tr('回复它，自己写…')
          : undefined
      }
      picked={picked}
      busy={resolve.isPending}
      hotkeys={hotkeys}
      footer={
        // 对话页里卡片只留它的话和选项
        !inSession &&
        (menu
          ? tr('选了就替它在终端里按下去')
          : tr('选一项或自己写，都会直接发回给它'))
      }
      onPick={(choice) => send(choice)}
      onFreeText={(text) => send(text, true)}
    />
  )
}

const rank = (d: Decision) =>
  d.urgency === 'high' ? 0 : d.urgency === 'normal' ? 1 : 2
