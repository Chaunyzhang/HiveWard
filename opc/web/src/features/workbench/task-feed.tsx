import { useState } from 'react'
import type { BusinessSummary, Task } from '@shared/api'
import { Laptop } from 'lucide-react'
import { timeAgo } from '@/lib/opc-format'
import { cn } from '@/lib/utils'
import {
  AgentLogo,
  AgentName,
  dispatcherAgent,
} from '@/components/opc/agent-logo'
import { Markdown } from '@/features/live/chat-view'
import { ReviewBar, ReviewChip } from './review-bar'
import {
  statusIcon,
  statusOrder,
  taskGroups,
  type TaskTab,
} from './task-status'

const DONE_PREVIEW = 6

/**
 * 任务与汇报：一张列表同时承载"在做什么"和"做完汇报了什么"。
 * 「全部」按 受阻 → 待复核 → 进行中 → 已完成 分组；切到某一栏只列该状态。行是隐藏的框，悬停变灰。
 * 已完成 / 失败的任务直接展示下属的汇报摘要（worker_done），点开看全文和改动文件；待复核的点开后能通过或打回。
 */
export function TaskFeed({
  tasks,
  tab,
  showBusiness,
  businessOf,
  machineOf,
}: {
  tasks: Task[]
  tab: TaskTab
  showBusiness: boolean
  /** 任务属于哪块业务（几台电脑合在一起时，业务要到任务所在那台电脑上找） */
  businessOf: (t: Task) => BusinessSummary | undefined
  /** 几台电脑合在一起看时：任务来自哪台 */
  machineOf?: (t: Task) => string | undefined
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [showAllDone, setShowAllDone] = useState(false)

  const groups =
    tab === 'all' ? taskGroups : taskGroups.filter((g) => g.key === tab)
  if (!tasks.some((t) => groups.some((g) => g.match(t))))
    return (
      <p className='px-2 py-6 text-[13px] text-muted-foreground'>
        这一栏没有任务。
      </p>
    )

  return (
    <div className='space-y-5'>
      {groups.map((g) => {
        const all = tasks
          .filter((t) => g.match(t))
          .sort(
            (a, b) =>
              statusOrder[a.status] - statusOrder[b.status] ||
              b.updatedAt.localeCompare(a.updatedAt)
          )
        if (all.length === 0) return null
        const rows =
          tab === 'all' && g.key === 'done' && !showAllDone
            ? all.slice(0, DONE_PREVIEW)
            : all
        return (
          <div key={g.key}>
            {tab === 'all' && (
              <h3 className='mb-1 flex items-baseline gap-2 px-2 text-xs text-muted-foreground'>
                <span className={cn(g.key === 'attention' && 'text-attention')}>
                  {g.label}
                </span>
                <span className='font-mono text-[11px]'>{all.length}</span>
              </h3>
            )}
            <ul>
              {rows.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  business={showBusiness ? businessOf(task) : undefined}
                  machine={machineOf?.(task)}
                  showProject={showBusiness}
                  open={task.id === openId}
                  onToggle={() =>
                    setOpenId(task.id === openId ? null : task.id)
                  }
                />
              ))}
            </ul>
            {rows.length < all.length && (
              <button
                type='button'
                onClick={() => setShowAllDone(true)}
                className='mt-1 px-2 text-xs text-muted-foreground hover:text-foreground'
              >
                显示全部 {all.length} 条
              </button>
            )}
          </div>
        )
      })}
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
  const s = statusIcon[t.status]
  const Icon = s.icon
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
        <Icon
          className={cn('mt-0.5 size-4 shrink-0', s.className)}
          aria-label={s.label}
        />
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
          <span className='hidden w-28 shrink-0 truncate text-xs text-muted-foreground sm:block'>
            {b ? b.name : t.project}
          </span>
        )}
        <span className='w-16 shrink-0 text-end text-xs text-muted-foreground'>
          {timeAgo(t.updatedAt)}
        </span>
      </button>
      {open && <ReviewBar task={t} />}
    </li>
  )
}
