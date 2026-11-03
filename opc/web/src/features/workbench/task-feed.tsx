import { useState } from 'react'
import type { BusinessSummary, Task } from '@shared/api'
import { Laptop } from 'lucide-react'
import {
  AgentLogo,
  AgentName,
  dispatcherAgent,
} from '@/components/opc/agent-logo'
import { Markdown } from '@/features/live/chat-view'
import { dayLabel, timeFmt } from '@/features/timeline'
import { ReviewBar, ReviewChip } from './review-bar'
import { TaskGlyph } from './task-status'

// 先列这么多，再多点「显示更多」
const PAGE = 30

/**
 * 任务页按状态筛出来的任务：和时间线一个样子——按天一块，左边是时间（最近动静），前面是状态图标。
 * 行是隐藏的框，悬停变灰。已完成 / 失败的任务直接展示下属的汇报摘要（worker_done），
 * 点开看全文和改动文件；待复核的点开后能通过或打回。
 */
export function TaskFeed({
  tasks,
  showBusiness,
  businessOf,
  machineOf,
  empty = '这里没有任务。',
}: {
  tasks: Task[]
  /** 筛完一条都没有时说什么 */
  empty?: string
  showBusiness: boolean
  /** 任务属于哪块业务（几台电脑合在一起时，业务要到任务所在那台电脑上找） */
  businessOf: (t: Task) => BusinessSummary | undefined
  /** 几台电脑合在一起看时：任务来自哪台 */
  machineOf?: (t: Task) => string | undefined
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)

  if (tasks.length === 0) {
    return (
      <p className='rounded-xl panel p-6 text-[13px] text-muted-foreground'>
        {empty}
      </p>
    )
  }
  const all = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  // 按天分组（已经是倒序）
  const days: { label: string; items: Task[] }[] = []
  for (const t of all.slice(0, shown)) {
    const label = dayLabel(t.updatedAt)
    const last = days.at(-1)
    if (last?.label === label) {
      last.items.push(t)
    } else {
      days.push({ label, items: [t] })
    }
  }
  return (
    <div className='space-y-5'>
      {days.map((day) => (
        <section key={day.label} className='rounded-xl panel'>
          <h2 className='flex h-10 items-center px-4 text-xs text-muted-foreground'>
            {day.label}
          </h2>
          <ol className='px-2 pb-2'>
            {day.items.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                business={showBusiness ? businessOf(task) : undefined}
                machine={machineOf?.(task)}
                showProject={showBusiness}
                open={task.id === openId}
                onToggle={() => setOpenId(task.id === openId ? null : task.id)}
              />
            ))}
          </ol>
        </section>
      ))}
      {shown < all.length && (
        <button
          type='button'
          onClick={() => setShown(shown + PAGE)}
          className='mx-auto flex h-8 items-center rounded-md px-4 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
        >
          更早的（还有 {all.length - shown} 条）
        </button>
      )}
    </div>
  )
}

function TaskRow({
  task: t,
  business: b,
  machine,
  showProject,
  open,
  onToggle,
}: {
  task: Task
  business?: BusinessSummary
  machine?: string
  showProject: boolean
  open: boolean
  onToggle: () => void
}) {
  const report = t.report
  const files = report
    ? [
        ...(report.filesModified ?? []),
        ...(report.reportPath ? [report.reportPath] : []),
      ]
    : []
  return (
    <li>
      <button
        type='button'
        onClick={onToggle}
        disabled={!report}
        data-open={open}
        className='flex w-full items-start gap-3 rounded-md hover-box px-2 py-2 text-start'
      >
        <span className='w-11 shrink-0 pt-px font-mono text-[11px] text-muted-foreground'>
          {timeFmt.format(new Date(t.updatedAt))}
        </span>
        <TaskGlyph task={t} className='mt-0.5' />
        <span className='min-w-0 flex-1'>
          <span className='flex items-baseline gap-2'>
            <span className='truncate text-[13px] leading-5'>{t.title}</span>
            <ReviewChip task={t} />
            {t.assignee && (t.status === 'dispatched' || t.dispatchedBy) && (
              <span className='inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground'>
                {t.dispatchedBy && (
                  <>
                    <AgentLogo
                      agent={dispatcherAgent(t.dispatchedBy.kind)}
                      className='size-3'
                    />
                    {t.dispatchedBy.label} →
                  </>
                )}
                <AgentName agent={t.assignee.agent} />
              </span>
            )}
          </span>
          {(t.status === 'blocked' || t.status === 'failed') &&
            t.blockedReason && (
              <span className='mt-0.5 block text-xs text-attention'>
                {t.blockedReason}
              </span>
            )}
          {open && t.followUps && (
            <span className='mt-1.5 block space-y-0.5 text-xs leading-5 text-muted-foreground'>
              {t.followUps.map((f, i) => (
                <span key={i} className='block'>
                  中途补充：{f}
                </span>
              ))}
            </span>
          )}
          {report && !open && (
            <span className='mt-0.5 line-clamp-1 text-xs leading-5 text-muted-foreground'>
              {report.outcome === 'failed' && (
                <span className='text-danger'>未完成 · </span>
              )}
              {report.summary.replace(/[*`|#>-]+/g, ' ')}
            </span>
          )}
          {report && open && (
            <span className='mt-1.5 block text-[13px] leading-6 text-foreground/85'>
              {report.outcome === 'failed' && (
                <span className='text-danger'>未完成 · </span>
              )}
              <Markdown text={report.summary} />
            </span>
          )}
          {open && files.length > 0 && (
            <span className='mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground'>
              {files.map((f) => (
                <span key={f}>{f}</span>
              ))}
            </span>
          )}
        </span>
        {machine && (
          <span
            title={machine}
            className='hidden max-w-28 shrink-0 items-center gap-1 truncate rounded bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground sm:inline-flex'
          >
            <Laptop className='size-3 shrink-0' />
            <span className='truncate'>{machine}</span>
          </span>
        )}
        {(b || (showProject && t.project)) && (
          <span className='hidden w-36 shrink-0 truncate text-end text-xs text-muted-foreground sm:block'>
            {b ? b.name : t.project}
          </span>
        )}
      </button>
      {open && <ReviewBar task={t} />}
    </li>
  )
}
