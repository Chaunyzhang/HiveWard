import { useState } from 'react'
import type { BusinessSummary, Task } from '@shared/api'
import { ChevronRight, Laptop } from 'lucide-react'
import { tr, trData } from '@/lib/i18n'
import {
  AgentLogo,
  AgentName,
  dispatcherAgent,
} from '@/components/hiveward/agent-logo'
import { Markdown } from '@/features/live/chat-view'
import { dayLabel, timeFmt } from '@/features/timeline'
import { useOpenSession } from './open-session'
import { ReviewBar, ReviewChip } from './review-bar'
import { TaskGlyph, taskFilterOf } from './task-status'

// 先列这么多，再多点「显示更多」
const PAGE = 30

const isPendingDecision = (t: Task) => taskFilterOf(t) === 'mine'

/**
 * 任务页按状态筛出来的任务：和时间线一个样子——按天一块，左边是时间（最近动静），前面是状态图标。
 * 行是隐藏的框，悬停变灰。已完成 / 失败的任务直接展示下属的汇报摘要（worker_done），
 * 点开看全文和改动文件。等你定的（待决策）且它的终端还在：点了直接跳到它的对话页（右栏后台任务里是在跑的那些）。
 */
export function TaskFeed({
  tasks,
  showBusiness,
  businessOf,
  machineOf,
  openable = isPendingDecision,
  empty = tr('这里没有任务。'),
}: {
  tasks: Task[]
  /** 筛完一条都没有时说什么 */
  empty?: string
  showBusiness: boolean
  /** 任务属于哪块业务（几台电脑合在一起时，业务要到任务所在那台电脑上找）；showBusiness 时才用 */
  businessOf?: (t: Task) => BusinessSummary | undefined
  /** 哪些任务点了直接去它的对话页（默认待决策的），其余点了在这里展开 */
  openable?: (t: Task) => boolean
  /** 几台电脑合在一起看时：任务来自哪台 */
  machineOf?: (t: Task) => string | undefined
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)
  const openSession = useOpenSession()

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
                business={showBusiness ? businessOf?.(task) : undefined}
                machine={machineOf?.(task)}
                showProject={showBusiness}
                open={task.id === openId}
                onToggle={() => setOpenId(task.id === openId ? null : task.id)}
                // 几台电脑合在一起看时，别的电脑上的会话这里打不开，照旧展开
                onOpen={
                  !machineOf?.(task) && task.terminal && openable(task)
                    ? () =>
                        openSession({
                          terminal: task.terminal!,
                          businessId: task.businessId,
                        })
                    : undefined
                }
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
          {tr('更早的（还有 {0} 条）', [all.length - shown])}
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
  onOpen,
}: {
  task: Task
  business?: BusinessSummary
  machine?: string
  showProject: boolean
  open: boolean
  onToggle: () => void
  /** 有这个时点整行去它的对话页，不在这里展开 */
  onOpen?: () => void
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
        onClick={onOpen ?? onToggle}
        disabled={!report && !onOpen}
        data-open={!onOpen && open}
        className='flex w-full items-start gap-3 rounded-md hover-box px-2 py-2 text-start'
      >
        <span className='w-11 shrink-0 pt-px font-mono text-[11px] text-muted-foreground'>
          {timeFmt.format(new Date(t.updatedAt))}
        </span>
        <TaskGlyph task={t} className='mt-0.5' />
        <span className='min-w-0 flex-1 wrap-anywhere'>
          {/* 窄的地方（右栏后台任务）标题占满一行，派单方 → 接单方折到下一行 */}
          <span className='flex flex-wrap items-baseline gap-x-2'>
            <span className='max-w-full truncate text-[13px] leading-5'>
              {trData(t.title)}
            </span>
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
                  {tr('中途补充：{0}', [f])}
                </span>
              ))}
            </span>
          )}
          {report && (!open || onOpen) && (
            <span className='mt-0.5 line-clamp-1 text-xs leading-5 text-muted-foreground'>
              {report.outcome === 'failed' && (
                <span className='text-danger'>{tr('未完成 ·')} </span>
              )}
              {report.summary.replace(/[*`|#>-]+/g, ' ')}
            </span>
          )}
          {report && open && !onOpen && (
            <span className='mt-1.5 block text-[13px] leading-6 text-foreground/85'>
              {report.outcome === 'failed' && (
                <span className='text-danger'>{tr('未完成 ·')} </span>
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
        {onOpen && (
          <span className='flex shrink-0 items-center gap-0.5 self-center text-xs text-brand'>
            {tr('去对话页')}
            <ChevronRight className='size-3.5' />
          </span>
        )}
        {(b || (showProject && t.project)) && (
          <span className='hidden w-36 shrink-0 truncate text-end text-xs text-muted-foreground sm:block'>
            {b ? b.name : t.project}
          </span>
        )}
      </button>
      {open && !onOpen && <ReviewBar task={t} />}
    </li>
  )
}
