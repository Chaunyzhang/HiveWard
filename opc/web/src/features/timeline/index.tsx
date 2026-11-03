import { useInfiniteQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type {
  BusinessSummary,
  Page as Paged,
  Task,
  TimelineEvent,
  TimelineKind,
} from '@shared/api'
import { LoaderCircle, MessageSquareReply } from 'lucide-react'
import { toast } from 'sonner'
import { scoped, useMachineId } from '@/lib/machine'
import { useOverview, useResumeRecord } from '@/lib/opc-api'
import { timelineKindLabel } from '@/lib/opc-format'
import { cn } from '@/lib/utils'
import { AgentLogo } from '@/components/opc/agent-logo'
import { ProjectLogo } from '@/components/opc/project-logo'
import { TaskGlyph } from '@/features/workbench/task-status'

const kindDot: Record<TimelineKind, string> = {
  leader: 'bg-brand',
  objective: 'bg-brand',
  task: 'bg-foreground/60',
  worker: 'bg-foreground/60',
  decision: 'bg-attention',
  instruction: 'bg-foreground/60',
  system: 'bg-muted-foreground/50',
  record: 'bg-done',
}

export const dayFmt = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
  weekday: 'short',
})
export const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
})

export function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) {
    return '今天'
  }
  if (d.toDateString() === yesterday.toDateString()) {
    return '昨天'
  }
  return dayFmt.format(d)
}

/**
 * 时间线：派活、汇报、待办、Agent 一轮干完、开关终端、项目变动，按时间倒序，往前翻。
 * 是任务页「全部」那一栏；scope 只看某块业务 / 某个项目。和任务有关的条目前面画这个任务现在的状态。
 */
export function Timeline({
  scope,
  preview,
  taskOf,
}: {
  scope?: { businessId?: string; projectId?: string }
  /** 概览里用：只列最近几条，不能往前翻 */
  preview?: boolean
  /** 条目关联的任务（画状态图标） */
  taskOf?: (taskId: string) => Task | undefined
}) {
  const machine = useMachineId()
  const { data: overview } = useOverview()
  const projects = (overview?.businesses ?? []).filter(
    (b) => b.status !== 'archived'
  )
  const businessId = scope?.businessId ?? ''
  const projectId = scope?.projectId ?? ''
  const events = useInfiniteQuery({
    queryKey: ['timeline', machine, businessId, projectId, !!preview],
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: preview ? '8' : '50' })
      if (businessId) {
        qs.set('businessId', businessId)
      }
      if (projectId) {
        qs.set('projectId', projectId)
      }
      if (pageParam) {
        qs.set('cursor', pageParam)
      }
      const res = await fetch(scoped(`/api/timeline?${qs}`, machine))
      const body: Paged<TimelineEvent> & {
        error?: { message?: string }
      } = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body.error?.message ?? `HTTP ${res.status}`)
      }
      return body
    },
    initialPageParam: '',
    getNextPageParam: (last) =>
      preview ? undefined : (last.nextCursor ?? undefined),
    refetchInterval: 5_000,
  })
  const items = events.data?.pages.flatMap((p) => p.items) ?? []
  const byId = byIdOf(projects)

  // 按天分组（items 已经是倒序）
  const days: { label: string; items: TimelineEvent[] }[] = []
  for (const e of items) {
    const label = dayLabel(e.ts)
    const last = days.at(-1)
    if (last?.label === label) {
      last.items.push(e)
    } else {
      days.push({ label, items: [e] })
    }
  }

  // 概览里已经在大框里了，预览不再套框
  const box = preview ? '' : 'rounded-xl panel'
  const list = (
    <>
      {events.isError ? (
        <p className={cn(box, 'p-6 text-xs text-danger')}>
          读取失败：{events.error.message}
        </p>
      ) : events.isLoading ? (
        <p className={cn(box, 'p-6 text-xs text-muted-foreground')}>读取中…</p>
      ) : items.length === 0 ? (
        <p className={cn(box, 'p-6 text-[13px] text-muted-foreground')}>
          还没有事件。派活、Agent 干完一轮、待办出现和处理，都会记在这里。
        </p>
      ) : (
        days.map((day) => (
          <section key={day.label} className={box}>
            <h2 className='flex h-10 items-center px-4 text-xs text-muted-foreground'>
              {day.label}
            </h2>
            <ol className='px-2 pb-2'>
              {day.items.map((e) => (
                <EventRow
                  key={e.id}
                  event={e}
                  project={e.businessId ? byId.get(e.businessId) : undefined}
                  showProject={!businessId}
                  task={e.taskId ? taskOf?.(e.taskId) : undefined}
                />
              ))}
            </ol>
          </section>
        ))
      )}

      {events.hasNextPage && (
        <button
          type='button'
          disabled={events.isFetchingNextPage}
          onClick={() => void events.fetchNextPage()}
          className='mx-auto flex h-8 items-center gap-1.5 rounded-md px-4 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
        >
          {events.isFetchingNextPage && (
            <LoaderCircle className='size-3 animate-spin' />
          )}
          更早的
        </button>
      )}
    </>
  )
  return <div className='space-y-5'>{list}</div>
}

const byIdOf = (list: BusinessSummary[]) => new Map(list.map((b) => [b.id, b]))

function EventRow({
  event: e,
  project,
  showProject,
  task,
}: {
  event: TimelineEvent
  project?: BusinessSummary
  showProject: boolean
  task?: Task
}) {
  const line = e.projectId
    ? project?.projects?.find((p) => p.id === e.projectId)
    : undefined
  const body = (
    <>
      <span className='w-11 shrink-0 pt-px font-mono text-[11px] text-muted-foreground'>
        {timeFmt.format(new Date(e.ts))}
      </span>
      {task ? (
        <TaskGlyph task={task} className='mt-0.5' />
      ) : (
        <span className='grid size-4 shrink-0 place-items-center pt-0.5'>
          <span className={cn('size-1.5 rounded-full', kindDot[e.kind])} />
        </span>
      )}
      <span className='min-w-0 flex-1'>
        <span className='flex items-center gap-2'>
          {e.agent && <AgentLogo agent={e.agent} className='size-3.5' />}
          <span className='truncate text-[13px]'>{e.title}</span>
          <span className='shrink-0 rounded bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground'>
            {timelineKindLabel[e.kind]}
          </span>
        </span>
        {e.detail && (
          <span className='mt-0.5 line-clamp-2 block text-xs leading-5 text-muted-foreground'>
            {e.detail}
          </span>
        )}
      </span>
      {showProject && (project || e.path) && (
        <span className='hidden w-36 shrink-0 items-center justify-end gap-1.5 truncate text-xs text-muted-foreground sm:flex'>
          {project && <ProjectLogo project={project} size={14} />}
          <span className='truncate'>
            {project?.name ?? e.path?.split('/').at(-1)}
            {line && ` · ${line.name}`}
          </span>
        </span>
      )}
    </>
  )
  const cls =
    'flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-2 text-start hover:bg-accent'
  // 有项目就能点：带终端的直接打开那个终端
  return (
    <li className='flex items-start gap-1'>
      {project ? (
        <Link
          to='/b/$businessId'
          params={{ businessId: project.id }}
          search={
            e.terminal
              ? { project: e.projectId, tab: 'live', t: e.terminal }
              : { project: e.projectId }
          }
          className={cls}
        >
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
      {e.kind === 'record' && e.recordId && (
        <ResumeButton recordId={e.recordId} businessId={project?.id} />
      )}
    </li>
  )
}

/** 工作记录「接着聊」：在原目录开新终端接上原来的会话，开好就跳过去 */
function ResumeButton({
  recordId,
  businessId,
}: {
  recordId: string
  businessId?: string
}) {
  const resume = useResumeRecord()
  const navigate = useNavigate()
  return (
    <button
      type='button'
      disabled={resume.isPending}
      title='在原目录开一个新终端，接上这次的会话'
      onClick={() =>
        resume.mutate(recordId, {
          onSuccess: ({ terminal }) => {
            toast.success('已重新打开')
            if (businessId) {
              void navigate({
                to: '/b/$businessId',
                params: { businessId },
                search: { tab: 'live', t: terminal },
              })
            }
          },
          onError: (err) => toast.error(`重新打开失败：${err.message}`),
        })
      }
      className='mt-1 flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50'
    >
      {resume.isPending ? (
        <LoaderCircle className='size-3 animate-spin' />
      ) : (
        <MessageSquareReply className='size-3' />
      )}
      接着聊
    </button>
  )
}
