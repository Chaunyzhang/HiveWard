import { useEffect, useRef, useState } from 'react'
import type { ChatItem } from '@shared/api'
import {
  ChevronRight,
  FilePen,
  FileText,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Markdown } from './markdown'

export { Markdown }

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type ThinkItem = Exclude<ChatItem, ToolItem> & { kind: 'thinking' }
/** 过程：思考和工具调用，正文之间的这些折成一组 */
type StepItem = ToolItem | ThinkItem
type TextItem = Exclude<ChatItem, StepItem>

const toolIcon = {
  command: SquareTerminal,
  read: FileText,
  edit: FilePen,
  other: Wrench,
}

/**
 * 对话视图：把终端里 Agent 的对话记录排成桌面端那种对话。
 * 你说的话靠右成气泡；Agent 的话正常排版；命令 / 读写文件折叠成一行，点开看输出。
 */
export function ChatView({
  items,
  working,
}: {
  items: ChatItem[]
  working: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const groups = groupSteps(items)

  // 用户停在底部时，新消息进来就跟着滚；往上翻看历史时不打扰
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items.length, working])

  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
      className='min-h-0 flex-1 overflow-y-auto'
    >
      {/* 排版对齐桌面端：正文 15px / 1.7 行高；辅助信息 13px 灰；等宽只用在命令和代码上；一行不超过约 40 个汉字，居中 */}
      <div className='mx-auto w-full max-w-[46rem] space-y-6 px-6 py-8 text-[15px] leading-[1.7] text-foreground'>
        {items.length === 0 && (
          <p className='py-10 text-center text-sm text-muted-foreground'>
            还没有对话，在下面跟它说点什么。
          </p>
        )}
        {groups.map((g, i) =>
          Array.isArray(g) ? (
            <StepGroup
              key={g[0].id}
              steps={g}
              live={working && i === groups.length - 1}
            />
          ) : (
            <Message key={g.id} item={g} />
          )
        )}
        {working && !Array.isArray(groups.at(-1)) && (
          <p className='shimmer-text text-[13px]'>干活中…</p>
        )}
      </div>
    </div>
  )
}

const isStep = (it: ChatItem): it is StepItem =>
  it.kind === 'tool' || it.kind === 'thinking'

/** 连续的思考和工具调用归成一组，像桌面端那样折在一起，正文读起来不被打断 */
function groupSteps(items: ChatItem[]): (TextItem | StepItem[])[] {
  const out: (TextItem | StepItem[])[] = []
  for (const it of items) {
    const last = out[out.length - 1]
    if (!isStep(it)) {
      out.push(it)
    } else if (Array.isArray(last)) {
      last.push(it)
    } else {
      out.push([it])
    }
  }
  return out
}

function Message({ item }: { item: TextItem }) {
  if (item.kind === 'user')
    return (
      <div className='flex justify-end'>
        <div className='max-w-[85%] rounded-2xl bg-accent px-4 py-2.5 whitespace-pre-wrap'>
          {item.text}
        </div>
      </div>
    )
  return <Markdown text={item.text} />
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <button
      type='button'
      onClick={() => setOpen(!open)}
      className={cn(
        'block w-full text-start text-[13px] leading-6 text-muted-foreground hover:text-foreground/80',
        !open && 'line-clamp-1',
        live && !open && 'shimmer-text'
      )}
    >
      {text}
    </button>
  )
}

/**
 * live：这是 Agent 正在做的最后一组。只有它会亮着扫光；之前的组哪怕记录里没收到结果，
 * Agent 已经往下走了，就不再显示「正在」。
 */
function StepGroup({ steps, live }: { steps: StepItem[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const tools = steps.filter((t): t is ToolItem => t.kind === 'tool')
  const running = live
  const failed = tools.filter((t) => t.status === 'error').length
  const last = tools[tools.length - 1]
  const only = steps.length === 1 ? steps[0] : null
  if (only) {
    return only.kind === 'tool' ? (
      <ToolRow tool={only} live={live} />
    ) : (
      <Thinking text={only.text} live={live} />
    )
  }
  return (
    <div>
      <button
        type='button'
        onClick={() => setOpen(!open)}
        className='flex w-full items-center gap-2 py-0.5 text-start text-[13px] text-muted-foreground hover:text-foreground'
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            open && 'rotate-90'
          )}
        />
        <span className={cn('shrink-0', running && 'shimmer-text')}>
          {tools.length
            ? running
              ? `正在执行第 ${tools.length} 步`
              : `执行了 ${tools.length} 步`
            : running
              ? '思考中'
              : '思考'}
          {failed > 0 && (
            <span className='text-danger'> · {failed} 步出错</span>
          )}
        </span>
        {!open && last && (
          <span
            className={cn(
              'truncate font-mono text-xs',
              running ? 'shimmer-text' : 'opacity-70'
            )}
          >
            {last.title}
          </span>
        )}
      </button>
      {open && (
        <div className='ms-[7px] mt-1 space-y-1 border-s ps-4'>
          {steps.map((t, i) =>
            t.kind === 'tool' ? (
              <ToolRow
                key={t.id}
                tool={t}
                live={running && i === steps.length - 1}
              />
            ) : (
              <p
                key={t.id}
                className='text-[13px] leading-6 text-muted-foreground'
              >
                {t.text}
              </p>
            )
          )}
        </div>
      )}
    </div>
  )
}

function ToolRow({ tool: t, live }: { tool: ToolItem; live: boolean }) {
  const [open, setOpen] = useState(false)
  const Icon = toolIcon[t.tool]
  // 正在跑的那条命令：扫光，像桌面端那样一眼看出卡在哪
  const running = live && t.status === 'running'
  return (
    <div>
      <button
        type='button'
        disabled={!t.output}
        onClick={() => setOpen(!open)}
        className='flex w-full items-center gap-2 py-0.5 text-start text-[13px] text-muted-foreground enabled:hover:text-foreground'
      >
        <Icon className='size-3.5 shrink-0' />
        <span
          className={cn(
            'truncate font-mono text-xs',
            running && 'shimmer-text'
          )}
        >
          {t.title}
        </span>
        {t.status === 'error' && (
          <span className='shrink-0 text-danger'>出错</span>
        )}
      </button>
      {open && t.output && (
        <pre className='mt-1.5 mb-2 max-h-72 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground/85'>
          {t.output}
        </pre>
      )}
    </div>
  )
}
