import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import type { Task } from '@shared/api'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { useDecisions, useReviewTask } from '@/lib/hiveward-api'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { FREE_KEY, QuestionCard } from '@/components/hiveward/question-card'
import { type AskItem, firstLine } from '@/features/live/ask-stack'
import { Markdown } from '@/features/live/chat-view'
import { awaitingReview } from '@/features/workbench/task-status'
import { DecisionCard } from './decision-list'

/**
 * 对话页输入框上面：这个 Agent 在等你定的事，和任务页「待决策」里的是同一件。
 * 交了活等复核的 → 只摆它的汇报和「通过 / 打回」，派单原文收在「看派单原文」里；
 * 它问你的话（不是终端菜单——菜单另有卡片）→ 和待决策里同样的提问卡片。
 * 返回一张张卡，由 AskStack 一次摆一张、能翻能收起。
 */
export function useSessionAsks({
  handle,
  tasks,
  seat,
}: {
  handle?: string
  tasks: Task[]
  /** 它坐在 Leader / CEO 位上：通过后终端不关，它留在座位上 */
  seat?: boolean
}): AskItem[] {
  const { data: decisions = [] } = useDecisions()
  if (!handle) {
    return []
  }
  const reviews = tasks.filter(
    (t) => t.terminal === handle && awaitingReview(t)
  )
  const asks = decisions.filter(
    (d) =>
      d.state === 'pending' && d.dispatch?.handle === handle && !d.dispatch.menu
  )
  return [
    ...reviews.map(
      (t): AskItem => ({
        key: `review:${t.id}:${t.review!.round}`,
        kind: 'review',
        summary: firstLine(t.report?.summary ?? '') || t.title,
        node: <ReviewAsk task={t} seat={seat} />,
      })
    ),
    ...asks.map(
      (d): AskItem => ({
        key: `decision:${d.id}`,
        kind: 'question',
        summary: d.question,
        node: <DecisionCard decision={d} hotkeys inSession />,
      })
    ),
  ]
}

/** 交了活等复核：看汇报，点「通过」或写打回意见 */
function ReviewAsk({ task: t, seat }: { task: Task; seat?: boolean }) {
  const review = useReviewTask()
  const router = useRouter()
  const [picked, setPicked] = useState<string | null>(null)
  const r = t.review!
  const [brief, setBrief] = useState(false)
  // 该你复核是卡片本身的意思，不再写；只在该派活的 Agent 复核、或打回过时提一句
  const meta = [
    r.reviewer === 'dispatcher' &&
      t.dispatchedBy &&
      tr('该 {0} 复核，你也可以直接定', [t.dispatchedBy.label]),
    r.round > 1 && tr('第 {0} 轮', [r.round]),
  ]
    .filter(Boolean)
    .join(' · ')

  const send = (verdict: 'accept' | 'rework', note?: string) => {
    if (review.isPending) {
      return
    }
    setPicked(verdict === 'accept' ? 'accept' : FREE_KEY)
    review.mutate(
      { id: t.id, verdict, note },
      {
        onSuccess: (res) => {
          if (verdict === 'rework') {
            toast.success(tr('已打回，意见发回它的终端了'))
            setPicked(null)
            return
          }
          if (res.closeError) {
            toast.warning(
              tr('已通过，记录已留下，但终端没关掉：{0}', [res.closeError])
            )
          } else if (seat) {
            toast.success(tr('已通过：时间线里留了工作记录，它还在座位上'))
          } else {
            toast.success(tr('已通过：终端已关，时间线里留了工作记录'))
            // 通过后它的终端关了，这个对话页也就没了：回到点进来的地方
            router.history.back()
          }
        },
        onError: (e) => {
          setPicked(null)
          toast.error(
            tr('{0}失败：{1}', [
              verdict === 'accept' ? tr('复核') : tr('打回'),
              e.message,
            ])
          )
        },
      }
    )
  }

  return (
    <QuestionCard
      meta={meta || undefined}
      body={
        <div className='space-y-1.5'>
          <div className='max-h-60 overflow-y-auto text-[14px] leading-6'>
            {t.report?.outcome === 'failed' && (
              <p className='text-danger'>{tr('它说没做完')}</p>
            )}
            {t.report?.summary ? (
              <Markdown text={t.report.summary} />
            ) : (
              <p className='text-muted-foreground'>
                {tr('它交活了，没写汇报')}
              </p>
            )}
          </div>
          <button
            type='button'
            onClick={() => setBrief(!brief)}
            className='flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground'
          >
            <ChevronRight
              className={cn(
                'size-3 transition-transform',
                brief && 'rotate-90'
              )}
            />
            {tr('看派单原文')}
          </button>
          {brief && (
            <p className='max-h-36 overflow-y-auto rounded-lg bg-muted/40 px-3 py-2 text-[13px] leading-5 wrap-anywhere whitespace-pre-wrap text-muted-foreground'>
              {t.title}
            </p>
          )}
        </div>
      }
      options={[
        {
          key: 'accept',
          label: tr('通过'),
          description: seat
            ? tr('记一笔工作记录，它留在座位上接着干')
            : tr('记一笔工作记录，关掉它的终端'),
        },
      ]}
      freeText={tr('不行，写打回意见发回给它…')}
      picked={picked}
      busy={review.isPending}
      onPick={() => send('accept')}
      onFreeText={(note) => send('rework', note)}
    />
  )
}
