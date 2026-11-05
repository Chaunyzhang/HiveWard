import { useState } from 'react'
import type { Task } from '@shared/api'
import { ChevronRight } from 'lucide-react'
import { timeAgo } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { AgentName } from '@/components/hiveward/agent-logo'
import { Markdown } from '@/features/live/chat-view'
import { TaskGlyph, taskFilterOf, taskLabel } from './task-status'

/**
 * 某个派单方派出去的活和结果（派单方详情、Grok Bot 主页共用）。
 * 一件活一行：状态、派的什么、谁在做、多久前；交回来的汇报先只露两行，点开看全文。
 * 上面一句话数清楚：派了几件、几件在做、几件等复核、几件做完。
 */
export function TaskList({ tasks }: { tasks: Task[] }) {
  const sorted = [...tasks].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )
  if (sorted.length === 0) {
    return (
      <p className='px-2 py-6 text-[13px] text-muted-foreground'>
        {tr('还没派过活。')}
      </p>
    )
  }
  const count = (f: ReturnType<typeof taskFilterOf>[]) =>
    sorted.filter((t) => f.includes(taskFilterOf(t))).length
  const parts = [
    [count(['active']), tr('在做')],
    [count(['mine', 'review']), tr('等复核')],
    [count(['done']), tr('做完')],
    [count(['failed']), tr('失败')],
  ] as const
  return (
    <div>
      <p className='px-2 pb-2 text-xs text-muted-foreground'>
        {tr('共派了 {0} 件{1}', [
          sorted.length,
          parts
            .filter(([n]) => n > 0)
            .map(([n, label]) => tr(' · {0} 件{1}', [n, label]))
            .join(''),
        ])}
      </p>
      <ul className='divide-y'>
        {sorted.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </ul>
    </div>
  )
}

function TaskRow({ task: t }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const report = t.report?.summary?.trim()
  return (
    <li className='px-2 py-3'>
      <div className='flex items-start gap-3'>
        <TaskGlyph task={t} className='mt-0.5' />
        <div className='min-w-0 flex-1'>
          <p
            title={t.title}
            className='line-clamp-2 text-[13px] leading-5 text-foreground'
          >
            {t.title}
          </p>
          <p className='mt-0.5 text-xs text-muted-foreground'>
            {taskLabel(t)} · <AgentName agent={t.assignee?.agent} />
            {t.project && <> · {t.project}</>} · {timeAgo(t.updatedAt)}
          </p>
          {t.blockedReason && (
            <p className='mt-1 text-xs text-attention'>{t.blockedReason}</p>
          )}
          {report && (
            <div className='mt-2'>
              {open ? (
                <div className='rounded-lg bg-muted/40 px-3 py-2 text-[13px] leading-6 text-foreground/85'>
                  <Markdown text={report} />
                </div>
              ) : (
                <p className='line-clamp-2 text-xs leading-5 text-muted-foreground'>
                  {preview(report)}
                </p>
              )}
              <button
                type='button'
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className='mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground'
              >
                {open ? tr('收起汇报') : tr('看完整汇报')}
                <ChevronRight
                  className={cn(
                    'size-3 transition-transform',
                    open && '-rotate-90'
                  )}
                />
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

/** 汇报的开头几句，去掉 Markdown 记号、表格和代码，只当预览 */
function preview(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*$/gm, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+]+\s*/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
