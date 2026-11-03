import type { Task } from '@shared/api'
import { timeAgo } from '@/lib/opc-format'
import { AgentName } from '@/components/opc/agent-logo'
import { Markdown } from '@/features/live/chat-view'
import { TaskGlyph } from './task-status'

/** 某个派单方派出去的活和结果，新的在前（派单方详情、Grok Bot 主页共用） */
export function TaskList({ tasks }: { tasks: Task[] }) {
  const sorted = [...tasks].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )
  return (
    <ul className='space-y-1'>
      {sorted.length === 0 && (
        <li className='px-2 py-6 text-[13px] text-muted-foreground'>
          还没派过活。
        </li>
      )}
      {sorted.map((t) => {
        return (
          <li key={t.id} className='rounded-md px-2 py-2.5 hover:bg-accent'>
            <div className='flex items-start gap-3'>
              <TaskGlyph task={t} className='mt-0.5' />
              <div className='min-w-0 flex-1'>
                <p className='flex items-baseline gap-2 text-[13px] leading-5'>
                  <span className='truncate'>{t.title}</span>
                  <span className='ms-auto shrink-0 text-[11px] text-muted-foreground'>
                    <AgentName agent={t.assignee?.agent} />
                    {t.project && <> · {t.project}</>} · {timeAgo(t.updatedAt)}
                  </span>
                </p>
                {t.report && (
                  <div className='mt-1.5 text-[13px] leading-6 text-foreground/85'>
                    <Markdown text={t.report.summary} />
                  </div>
                )}
                {t.blockedReason && (
                  <p className='mt-1 text-xs text-attention'>
                    {t.blockedReason}
                  </p>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
