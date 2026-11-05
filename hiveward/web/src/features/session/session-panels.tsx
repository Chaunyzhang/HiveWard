import { CheckCircle2, Circle, CircleDot, X } from 'lucide-react'
import { useWorkspace } from '@/stores/workspace'
import { timeAgo } from '@/lib/hiveward-format'
import { useHiveWardTerminals } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { MissingEndpoint, useSessionPlan } from '@/lib/session-panels-api'
import { cn } from '@/lib/utils'
import { AgentConsole } from '@/features/live/agent-console'
import { TaskFeed } from '@/features/workbench/task-feed'
import { taskFilterOf } from '@/features/workbench/task-status'
import { useFocusedSession } from './use-focused-session'

/** 右栏「计划」：Agent 自己列的待办（Claude 的 TodoWrite、Codex 的计划、Kimi 的待办），取最后一版 */
export function PlanPanel({ handle }: { handle: string }) {
  const plan = useSessionPlan(handle)
  const items = plan.data?.items ?? []
  const done = items.filter((t) => t.status === 'completed').length
  return (
    <div className='min-h-0 flex-1 overflow-y-auto'>
      {items.length > 0 && (
        <div className='flex h-9 items-center gap-2 border-b px-4 text-xs text-muted-foreground'>
          <span>{tr('{0}/{1} 完成', [done, items.length])}</span>
          {plan.data?.updatedAt && (
            <span className='ms-auto'>
              {tr('更新于 {0}', [timeAgo(plan.data.updatedAt)])}
            </span>
          )}
        </div>
      )}
      {plan.isLoading ? (
        <Note>{tr('读取计划…')}</Note>
      ) : plan.error instanceof MissingEndpoint ? (
        <Note>
          {tr('后台还是旧版本，读不了计划。更新 HiveWard 后就能在这里看。')}
        </Note>
      ) : plan.error ? (
        <Note tone='danger'>{tr('读不到计划：{0}', [plan.error.message])}</Note>
      ) : !plan.data?.source ? (
        <Note>{tr('没找到这个 Agent 的对话记录，看不了它的计划。')}</Note>
      ) : items.length === 0 ? (
        <Note>
          {tr('Agent 还没列计划。它用待办清单拆活时，会显示在这里。')}
        </Note>
      ) : (
        <ol className='space-y-0.5 px-2 py-2'>
          {items.map((t, i) => (
            <li
              key={i}
              className='flex items-start gap-2.5 rounded-md px-2 py-1.5 text-[13px] leading-5'
            >
              {t.status === 'completed' ? (
                <CheckCircle2 className='mt-0.5 size-4 shrink-0 text-done' />
              ) : t.status === 'in_progress' ? (
                <CircleDot className='mt-0.5 size-4 shrink-0 animate-pulse text-working' />
              ) : (
                <Circle className='mt-0.5 size-4 shrink-0 text-muted-foreground/60' />
              )}
              <span
                className={cn(
                  t.status === 'completed' &&
                    'text-muted-foreground line-through',
                  t.status === 'in_progress' && 'font-medium'
                )}
              >
                {t.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** 右栏「后台任务」：这个会话派出去、还在跑的活，和任务页同一套列表；点一件去做它的那个会话 */
export function BackgroundTasksPanel() {
  const focused = useFocusedSession()
  if (!focused) {
    return null
  }
  return (
    <div className='min-h-0 flex-1 overflow-y-auto p-3'>
      <TaskFeed
        tasks={focused.running}
        showBusiness={false}
        openable={(t) => taskFilterOf(t) === 'active'}
        empty={tr('这个会话没有在跑的后台任务。')}
      />
    </div>
  )
}

/** 右栏「侧边对话」：再开一个会话的对话，和中间的主对话并排 */
export function SideChatPanel() {
  const handle = useWorkspace((s) => s.sideChat)
  const setSideChat = useWorkspace((s) => s.setSideChat)
  const terminals = useHiveWardTerminals()
  const terminal = terminals.data?.find((t) => t.handle === handle)
  if (!handle) {
    return (
      <Note>
        {tr('在「更多 → 侧边对话」里选一个会话，它会在这里和主对话并排。')}
      </Note>
    )
  }
  if (!terminal) {
    return (
      <Note>
        {terminals.isLoading
          ? tr('连接引擎…')
          : tr('这个会话的终端已经关掉了。')}
      </Note>
    )
  }
  return (
    <AgentConsole
      key={terminal.handle}
      terminal={terminal}
      focus={false}
      className='min-h-0 flex-1'
      headerClassName='px-3'
      trailing={
        <button
          type='button'
          title={tr('关掉侧边对话')}
          aria-label={tr('关掉侧边对话')}
          onClick={() => setSideChat(null)}
          className='grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
        >
          <X className='size-4' />
        </button>
      }
    />
  )
}

/** 右栏面板里的一句说明（空、读取中、读不到） */
export function Note({
  children,
  tone,
}: {
  children: React.ReactNode
  tone?: 'danger'
}) {
  return (
    <p
      className={cn(
        'px-6 py-8 text-center text-xs leading-5 text-muted-foreground',
        tone === 'danger' && 'text-danger'
      )}
    >
      {children}
    </p>
  )
}
