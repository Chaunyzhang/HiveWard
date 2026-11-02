import { useState } from 'react'
import type { Task } from '@shared/api'
import { toast } from 'sonner'
import { useReviewTask } from '@/lib/opc-api'
import { Textarea } from '@/components/ui/textarea'

/** 任务行上的复核标签：待复核 / 打回重做 / 已通过；没进复核的旧派单不显示 */
export function ReviewChip({ task: t }: { task: Task }) {
  const r = t.review
  if (!r) {
    return null
  }
  if (r.state === 'awaiting') {
    return (
      <span className='shrink-0 rounded bg-attention/15 px-1.5 text-[11px] leading-5 text-attention'>
        完成·待复核{r.round > 1 && ` · 第 ${r.round} 轮`}
      </span>
    )
  }
  if (r.state === 'rework') {
    return (
      <span className='shrink-0 rounded bg-brand/15 px-1.5 text-[11px] leading-5 text-brand'>
        打回重做 · 第 {r.round} 轮
      </span>
    )
  }
  return (
    <span className='shrink-0 rounded bg-done/15 px-1.5 text-[11px] leading-5 text-done'>
      已通过
    </span>
  )
}

/**
 * 待复核的派单展开后底下的一栏：通过 → 后台关掉它的终端、时间线留一条工作记录；
 * 打回 → 写意见发回它的终端接着改。谁派的谁复核，老板（网页）能复核任何一条。
 */
export function ReviewBar({ task: t }: { task: Task }) {
  const [reworking, setReworking] = useState(false)
  const [note, setNote] = useState('')
  const review = useReviewTask()
  const r = t.review
  if (r?.state !== 'awaiting') {
    return r?.state === 'rework' && r.note ? (
      <p className='mt-1.5 px-2 ps-9 text-xs leading-5 text-muted-foreground'>
        打回意见：{r.note}
      </p>
    ) : null
  }

  const who =
    r.reviewer === 'dispatcher' && t.dispatchedBy
      ? `该 ${t.dispatchedBy.label} 复核，你也可以直接定`
      : '该你复核'

  const accept = () =>
    review.mutate(
      { id: t.id, verdict: 'accept' },
      {
        onSuccess: (res) =>
          res.closeError
            ? toast.warning(
                `已通过，记录已留下，但终端没关掉：${res.closeError}`
              )
            : toast.success('已通过：终端已关，时间线里留了工作记录'),
        onError: (e) => toast.error(`复核失败：${e.message}`),
      }
    )
  const rework = () =>
    review.mutate(
      { id: t.id, verdict: 'rework', note: note.trim() },
      {
        onSuccess: () => {
          toast.success('已打回，意见发回它的终端了')
          setReworking(false)
          setNote('')
        },
        onError: (e) => toast.error(`打回失败：${e.message}`),
      }
    )

  return (
    <div className='mt-1 mb-2 ps-9 pe-2'>
      {reworking ? (
        <div className='flex items-end gap-1.5'>
          <Textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='哪里不行、要怎么改：原样发回它的终端'
            rows={2}
            className='min-h-8 flex-1 resize-none py-1.5 text-xs md:text-xs'
          />
          <button
            type='button'
            onClick={() => setReworking(false)}
            className='h-8 shrink-0 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground'
          >
            取消
          </button>
          <button
            type='button'
            disabled={!note.trim() || review.isPending}
            onClick={rework}
            className='h-8 shrink-0 rounded-md bg-foreground px-3 text-xs text-background transition-opacity disabled:opacity-30'
          >
            发回
          </button>
        </div>
      ) : (
        <div className='flex items-center gap-1.5'>
          <span className='me-auto text-xs text-muted-foreground'>{who}</span>
          <button
            type='button'
            disabled={review.isPending}
            onClick={() => setReworking(true)}
            className='h-7 rounded-md border hover-box px-3 text-xs disabled:opacity-50'
          >
            打回
          </button>
          <button
            type='button'
            disabled={review.isPending}
            onClick={accept}
            title='关掉它的终端，时间线里留一条工作记录'
            className='h-7 rounded-md bg-foreground px-3 text-xs text-background transition-opacity disabled:opacity-30'
          >
            通过
          </button>
        </div>
      )}
    </div>
  )
}
