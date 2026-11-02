import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { BusinessSummary, Decision } from '@shared/api'
import { toast } from 'sonner'
import { scoped, useMachineId } from '@/lib/machine'
import { useDecisions, useOverview, useResolveDecision } from '@/lib/opc-api'
import { timeAgo, urgencyStyle } from '@/lib/opc-format'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

// 小窗口里最多摆几行选项；再多就进详情页处理
const COMPACT_OPTIONS = 3

/**
 * 待办（待我决定）列表：一行一件事，点开就地展开。首页和抽屉共用。
 * 选项一律是同级、等宽的整行按钮（负责人建议的只多一个「建议」标记），最多 3 行；
 * 下面是回复框 + 自定义回复。选项多于 3 个或内容放不下，进详情页处理。
 */
export function DecisionList({
  businessId,
  onNavigate,
}: {
  businessId?: string
  onNavigate?: () => void
}) {
  const { data: decisions = [] } = useDecisions()
  const { data: overview } = useOverview()
  const pending = decisions
    .filter((d) => d.state === 'pending')
    .filter((d) => !businessId || d.businessId === businessId)
    .sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt))
  const [openId, setOpenId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const expanded = openId ?? pending[0]?.id
  const businessOf = (d: Decision) =>
    overview?.businesses.find((b) => b.id === d.businessId)
  const detail = pending.find((d) => d.id === detailId)

  if (pending.length === 0)
    return (
      <p className='px-2 py-6 text-[13px] text-muted-foreground'>
        没有需要你决定的事。
      </p>
    )

  return (
    <>
      <ul className='space-y-0.5'>
        {pending.map((d) => {
          const b = businessOf(d)
          const open = d.id === expanded
          return (
            <li key={d.id}>
              <button
                type='button'
                onClick={() => setOpenId(open ? '' : d.id)}
                className='flex w-full items-start gap-3 rounded-md hover-box px-2 py-2 text-start'
              >
                <span
                  className={cn(
                    'mt-[7px] size-1.5 shrink-0 rounded-full',
                    urgencyStyle[d.urgency].dot
                  )}
                />
                <span className='min-w-0 flex-1'>
                  <span
                    className={cn(
                      'block text-[13px] leading-5',
                      open && 'font-medium'
                    )}
                  >
                    {d.question}
                  </span>
                  <span className='mt-0.5 block text-xs text-muted-foreground'>
                    <Meta decision={d} business={b} />
                  </span>
                </span>
              </button>
              {open && (
                <div className='px-2 ps-[26px] pb-3'>
                  <Actions
                    decision={d}
                    compact
                    onDetail={() => setDetailId(d.id)}
                  />
                  {b && onNavigate !== undefined && (
                    <Link
                      to='/b/$businessId'
                      params={{ businessId: b.id }}
                      onClick={onNavigate}
                      className='ms-4 mt-2 inline-block text-xs text-muted-foreground hover:text-foreground'
                    >
                      查看 {b.name} →
                    </Link>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetailId(null)}>
        <DialogContent className='gap-0 sm:max-w-lg'>
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className='pe-6 text-sm leading-6 font-medium'>
                  {detail.question}
                </DialogTitle>
                <DialogDescription className='text-xs'>
                  <Meta decision={detail} business={businessOf(detail)} />
                </DialogDescription>
              </DialogHeader>
              <div className='mt-4'>
                <Actions decision={detail} onDone={() => setDetailId(null)} />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function Meta({
  decision: d,
  business: b,
}: {
  decision: Decision
  business?: BusinessSummary
}) {
  return (
    <>
      {b?.name} · {urgencyStyle[d.urgency].label} · {timeAgo(d.createdAt)}
    </>
  )
}

/**
 * 说明 + 同级选项 + 回复框/自定义。
 * compact：小窗口版，说明两行截断、选项最多 3 行且单行截断，放不下时给「详情」入口。
 */
function Actions({
  decision: d,
  compact,
  onDetail,
  onDone,
}: {
  decision: Decision
  compact?: boolean
  onDetail?: () => void
  onDone?: () => void
}) {
  const [reply, setReply] = useState('')
  const resolve = useResolveDecision()
  const machine = useMachineId()
  const text = reply.trim()

  const send = (choice: string, custom?: boolean) =>
    resolve.mutate(
      {
        id: d.id,
        choice,
        note: custom ? undefined : text || undefined,
        custom,
      },
      {
        onSuccess: () => {
          toast.success(custom ? '已把你的回复发回去' : `已回复：${choice}`)
          onDone?.()
        },
        onError: (e) => toast.error(`回复失败：${e.message}`),
      }
    )

  const shown = compact ? d.options.slice(0, COMPACT_OPTIONS) : d.options
  const hidden = d.options.length - shown.length

  return (
    <div>
      {d.body && (
        <p
          className={cn(
            'text-xs leading-5 text-muted-foreground',
            compact && 'line-clamp-2'
          )}
        >
          {d.body}
        </p>
      )}
      {d.screenshot && (
        <a
          href={scoped(d.screenshot, machine)}
          target='_blank'
          rel='noreferrer'
          title='看大图'
        >
          <img
            src={scoped(d.screenshot, machine)}
            alt='Agent 附的截图'
            className={cn(
              'mt-2 w-full rounded-md border object-cover object-top',
              compact ? 'max-h-28' : 'max-h-80'
            )}
          />
        </a>
      )}

      <div className='mt-2.5 space-y-1.5'>
        {shown.map((opt) => (
          <button
            key={opt}
            type='button'
            title={opt}
            disabled={resolve.isPending}
            onClick={() => send(opt)}
            className='flex min-h-8 w-full items-center gap-2 rounded-md border hover-box px-3 py-1.5 text-start text-xs disabled:opacity-50'
          >
            <span
              className={cn(
                'min-w-0 flex-1',
                compact ? 'truncate' : 'leading-5'
              )}
            >
              {opt}
            </span>
            {opt === d.recommendation && (
              <span className='shrink-0 text-[11px] text-brand'>建议</span>
            )}
          </button>
        ))}
      </div>

      <div className='mt-2.5 flex items-end gap-1.5'>
        <Textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder={
            compact
              ? '回复负责人…'
              : '回复负责人：点选项时一起带上，或点「自定义」单独发送'
          }
          rows={compact ? 1 : 3}
          className='min-h-8 flex-1 resize-none py-1.5 text-xs md:text-xs'
        />
        <button
          type='button'
          disabled={!text || resolve.isPending}
          onClick={() => send(text, true)}
          className='h-8 shrink-0 rounded-md bg-foreground px-3 text-xs text-background transition-opacity disabled:opacity-30'
        >
          自定义
        </button>
      </div>

      {compact && (
        <button
          type='button'
          onClick={onDetail}
          className={cn(
            'mt-2 text-xs hover:text-foreground',
            hidden ? 'text-attention' : 'text-muted-foreground'
          )}
        >
          {hidden ? `还有 ${hidden} 个选项，打开详情 →` : '详情 →'}
        </button>
      )}
    </div>
  )
}

const rank = (d: Decision) =>
  d.urgency === 'high' ? 0 : d.urgency === 'normal' ? 1 : 2
