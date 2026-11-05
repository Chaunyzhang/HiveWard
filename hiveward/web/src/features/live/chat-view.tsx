import { useEffect, useRef, useState } from 'react'
import type { ChatItem, HiveWardChat } from '@shared/api'
import {
  Bell,
  Check,
  Circle,
  CircleCheck,
  ChevronRight,
  Copy,
  FilePen,
  FileText,
  Square,
  SquareTerminal,
  Volume2,
  Wrench,
} from 'lucide-react'
import { create } from 'zustand'
import { timeAgo } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { AgentSpinner } from '@/components/hiveward/agent-spinner'
import { ChatImages } from './chat-images'
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
 * 你说的话靠右成气泡；Agent 的话正常排版；连着的命令 / 读写文件折成一行「已运行 N 个命令」，点开看每条、再点看输出。
 * Agent 每一轮回完话，下面一排小按钮：复制这一轮的回复、朗读、多久前（最后一轮常显，之前的悬停才出来）。
 */
export function ChatView({
  items,
  working,
  agent,
  plan,
}: {
  items: ChatItem[]
  working: boolean
  /** 哪家的 Agent：底下「正在运行」那一行用它家自己的转圈 */
  agent?: string | null
  /** Agent 自己列的任务清单：这一轮列过的话压在最新一条消息下面 */
  plan?: HiveWardChat['plan']
}) {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const groups = groupSteps(items)
  const turns = turnEnds(groups, working)
  // 你最后说的那句（系统塞进来的通知、压缩摘要不算）
  const lastUser = lastWhere(
    items,
    (it) => it.kind === 'user' && !systemNotice(it.text)
  )
  // 清单这一轮列过 / 改过，或者还有没做完的，就挂着；上一轮早做完的旧清单不再显示
  const checklist =
    plan?.items.length &&
    (!lastUser?.ts ||
      !plan.updatedAt ||
      plan.updatedAt >= lastUser.ts ||
      plan.items.some((t) => t.status !== 'completed'))
      ? plan.items
      : null
  const live = working ? liveStep(groups, lastUser) : null

  // 用户停在底部时，新消息进来就跟着滚；往上翻看历史时不打扰
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items.length, working, checklist?.length])

  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
      className='min-h-0 flex-1 overflow-x-hidden overflow-y-auto'
    >
      {/* 排版对齐桌面端：正文 15px / 1.7 行高；辅助信息 13px 灰；等宽只用在命令和代码上；一行不超过约 40 个汉字，居中 */}
      {/* 长路径 / URL / 英文 token 随处可断，不把这一栏撑得比面板宽（撑宽了整栏能被横着拖走、左边的字被裁） */}
      <div className='mx-auto w-full max-w-[46rem] min-w-0 space-y-6 px-6 py-8 text-[15px] leading-[1.7] wrap-anywhere text-foreground'>
        {items.length === 0 && (
          <p className='py-10 text-center text-sm text-muted-foreground'>
            {tr('还没有对话，在下面跟它说点什么。')}
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
            <Message
              key={g.id}
              item={g}
              turn={turns.ends.get(i)}
              latest={i === turns.last}
            />
          )
        )}
        {checklist && <Checklist items={checklist} />}
        {live && <LiveRow agent={agent} {...live} />}
      </div>
    </div>
  )
}

/**
 * 每一轮（你说一句到下一句之间）Agent 最后那段话的位置 → 这一轮它说的所有话（复制时整轮一起）。
 * 最后一轮还在干活时不算回完，不挂按钮。
 */
function turnEnds(groups: (TextItem | StepItem[])[], working: boolean) {
  const ends = new Map<number, TextItem[]>()
  let last = -1
  let said: TextItem[] = []
  let at = -1
  const close = () => {
    if (at >= 0) {
      ends.set(at, said)
      last = at
    }
    said = []
    at = -1
  }
  groups.forEach((g, i) => {
    if (Array.isArray(g)) {
      return
    }
    if (g.kind === 'user') {
      close()
    } else {
      said.push(g)
      at = i
    }
  })
  if (!working) {
    close()
  }
  return { ends, last }
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

/**
 * 不是人说的、是系统塞给 Agent 的消息（后台任务通知、监控事件这类 <task-notification> …）：
 * 不画成你的气泡，像桌面端那样排成一行灰字，点开看原文。
 */
function systemNotice(text: string) {
  const tag = /^\s*<([a-z][\w-]*)>/i.exec(text)?.[1]
  if (!tag) {
    return null
  }
  const field = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim()
  const summary = field('summary')?.replace(/^Monitor event:\s*/i, '')
  return {
    label: tag === 'task-notification' ? tr('后台通知') : tr('系统消息'),
    summary: summary?.replace(/^"|"$/g, '') ?? tag,
    detail: field('event') ?? field('result'),
  }
}

function Notice({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const n = systemNotice(text)
  if (!n) {
    return null
  }
  return (
    <div className='text-[13px] text-muted-foreground'>
      <button
        type='button'
        onClick={() => setOpen(!open)}
        className='flex w-full items-center gap-2 text-start hover:text-foreground'
      >
        <Bell className='size-3.5 shrink-0' />
        <span className='shrink-0'>{n.label}</span>
        <span className='truncate'>{n.summary}</span>
        {n.detail && !open && (
          <span className='truncate font-mono text-xs opacity-70'>
            {n.detail}
          </span>
        )}
      </button>
      {open && (
        <pre className='mt-1.5 max-h-60 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground/85'>
          {text.trim()}
        </pre>
      )}
    </div>
  )
}

function Message({
  item,
  turn,
  latest,
}: {
  item: TextItem
  /** 这一段是这一轮 Agent 最后说的话时：整轮说的话（下面挂按钮） */
  turn?: TextItem[]
  /** 最近回完的一轮：按钮常显 */
  latest?: boolean
}) {
  if (item.kind === 'user' && systemNotice(item.text)) {
    return <Notice text={item.text} />
  }
  if (item.kind === 'user') {
    return (
      <div className='group flex flex-col items-end gap-1'>
        {item.images?.length ? (
          <ChatImages
            images={item.images}
            className='max-w-[85%] justify-end'
          />
        ) : null}
        {item.text && (
          <div className='max-w-[85%] rounded-2xl bg-accent px-4 py-2.5 whitespace-pre-wrap'>
            {item.text}
          </div>
        )}
        {item.text && (
          <div className='flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100'>
            <CopyButton text={item.text} />
          </div>
        )}
      </div>
    )
  }
  if (!turn) {
    return (
      <div>
        {item.images?.length ? <ChatImages images={item.images} /> : null}
        <Markdown text={item.text} />
      </div>
    )
  }
  const text = turn.map((t) => t.text.trim()).join('\n\n')
  return (
    <div className='group'>
      {item.images?.length ? <ChatImages images={item.images} /> : null}
      <Markdown text={item.text} />
      <div
        className={cn(
          '-ms-1.5 mt-2 flex items-center gap-0.5 transition-opacity',
          !latest &&
            'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
        )}
      >
        <CopyButton text={text} />
        <SpeakButton id={item.id} text={text} />
        {item.ts && (
          <span
            title={new Date(item.ts).toLocaleString()}
            className='ms-2 text-xs text-muted-foreground'
          >
            {timeAgo(item.ts)}
          </span>
        )}
      </div>
    </div>
  )
}

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          aria-label={label}
          onClick={onClick}
          className='grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent [&_svg]:size-4'
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side='bottom'>{label}</TooltipContent>
    </Tooltip>
  )
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <ActionButton
      label={done ? tr('已复制') : tr('复制')}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }
    >
      {done ? <Check /> : <Copy />}
    </ActionButton>
  )
}

/** 正在朗读哪一段：同一时间只读一段，点别的就换过去 */
const useSpeaking = create<{ id: string | null }>(() => ({ id: null }))

function SpeakButton({ id, text }: { id: string; text: string }) {
  const speaking = useSpeaking((s) => s.id === id)
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return null
  }
  const toggle = () => {
    window.speechSynthesis.cancel()
    if (speaking) {
      useSpeaking.setState({ id: null })
      return
    }
    const u = new SpeechSynthesisUtterance(plainText(text))
    u.lang = /[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'
    const done = () =>
      useSpeaking.setState((s) => (s.id === id ? { id: null } : s))
    u.onend = done
    u.onerror = done
    useSpeaking.setState({ id })
    window.speechSynthesis.speak(u)
  }
  return (
    <ActionButton
      label={speaking ? tr('停止朗读') : tr('朗读')}
      onClick={toggle}
    >
      {speaking ? <Square /> : <Volume2 />}
    </ActionButton>
  )
}

/** 朗读前去掉 Markdown 记号和代码块，免得把星号、井号、整段代码念出来 */
function plainText(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, '（代码略）')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/^[#>\-*+]+\s*/gm, '')
    .replace(/[*_~|]/g, '')
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
  const all = steps.filter((t): t is ToolItem => t.kind === 'tool')
  const last = all.at(-1)
  // 还在跑的那条交给底下「正在运行」那一行，这里只概括跑完的
  const tools =
    live && last?.status === 'running' && steps.at(-1) === last
      ? all.slice(0, -1)
      : all
  const failed = tools.filter((t) => t.status === 'error').length
  const only = steps.length === 1 ? steps[0] : null
  if (only?.kind === 'thinking') {
    return <Thinking text={only.text} live={live} />
  }
  if (tools.length === 0 && all.length > 0) {
    return null
  }
  return (
    <div>
      <button
        type='button'
        onClick={() => setOpen(!open)}
        className='flex w-full items-center gap-2 py-0.5 text-start text-[13px] text-muted-foreground hover:text-foreground'
      >
        <span className='min-w-0'>
          {stepSummary(tools)}
          {failed > 0 && (
            <span className='text-danger'> {tr('· {0} 个出错', [failed])}</span>
          )}
        </span>
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            open && 'rotate-90'
          )}
        />
      </button>
      {open && (
        <div className='ms-[7px] mt-1 space-y-1 border-s ps-4'>
          {steps.map((t, i) =>
            t.kind === 'tool' ? (
              <ToolRow
                key={t.id}
                tool={t}
                live={live && i === steps.length - 1}
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

/** 这一组干了什么，像桌面端那样一句话：已运行 3 个命令，读取 2 个文件 */
function stepSummary(tools: ToolItem[]) {
  const n = { command: 0, read: 0, edit: 0, other: 0 }
  for (const t of tools) {
    n[t.tool] += 1
  }
  const parts = [
    n.command && tr('运行 {0} 个命令', [n.command]),
    n.read && tr('读取 {0} 个文件', [n.read]),
    n.edit && tr('修改 {0} 个文件', [n.edit]),
    n.other && tr('调用 {0} 个工具', [n.other]),
  ].filter(Boolean)
  if (parts.length === 0) {
    return tr('思考')
  }
  return tr('已{0}', [parts.join(tr('，'))])
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
        disabled={!t.output && !t.images?.length}
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
          <span className='shrink-0 text-danger'>{tr('出错')}</span>
        )}
      </button>
      {open && t.output && (
        <pre className='mt-1.5 mb-2 max-h-72 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground/85'>
          {t.output}
        </pre>
      )}
      {open && t.images?.length ? (
        <ChatImages images={t.images} className='mt-1.5 mb-2' />
      ) : null}
    </div>
  )
}

function lastWhere<T>(list: T[], ok: (x: T) => boolean) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (ok(list[i])) {
      return list[i]
    }
  }
  return undefined
}

/**
 * 底下那一行「正在运行 …  3分28秒」：在跑命令时是那条命令、从它开始算；
 * 没在跑命令（想、写回复）时是「思考中」，从你最后说那句算。
 */
function liveStep(
  groups: (TextItem | StepItem[])[],
  lastUser: ChatItem | undefined
): { label: string; detail?: string; since?: string } {
  const g = groups.at(-1)
  const last = Array.isArray(g) ? g.at(-1) : undefined
  if (last?.kind === 'tool' && last.status === 'running') {
    const verb = {
      command: tr('正在运行'),
      read: tr('正在读取'),
      edit: tr('正在修改'),
      other: tr('正在调用'),
    }[last.tool]
    return { label: verb, detail: last.title, since: last.ts ?? lastUser?.ts }
  }
  return { label: tr('思考中'), since: lastUser?.ts }
}

function LiveRow({
  agent,
  label,
  detail,
  since,
}: {
  agent?: string | null
  label: string
  detail?: string
  since?: string
}) {
  return (
    <div className='flex items-center gap-2 text-[13px] text-muted-foreground'>
      <AgentSpinner agent={agent} className='text-[15px]' />
      <span className='shrink-0 shimmer-text'>{label}</span>
      {detail && (
        <span className='min-w-0 shimmer-text truncate font-mono text-xs'>
          {detail}
        </span>
      )}
      {since && <Elapsed since={since} />}
    </div>
  )
}

/** 从 since 起过了多久，每秒走一次：12秒、3分28秒、1小时2分 */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1_000))
  if (!Number.isFinite(s)) {
    return null
  }
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const text = h
    ? tr('{0}小时{1}分', [h, m])
    : m
      ? tr('{0}分{1}秒', [m, s % 60])
      : tr('{0}秒', [s])
  return <span className='shrink-0 tabular-nums'>{text}</span>
}

/** Agent 自己列的任务清单，像桌面端那样一列勾：做完的打勾划掉，正在做的亮着 */
function Checklist({
  items,
}: {
  items: NonNullable<HiveWardChat['plan']>['items']
}) {
  const done = items.filter((t) => t.status === 'completed').length
  return (
    <div className='rounded-xl border bg-panel px-4 py-3 text-[13px]'>
      <div className='mb-1.5 flex items-center text-xs text-muted-foreground'>
        {tr('任务清单')}
        <span className='ms-auto tabular-nums'>
          {done}/{items.length}
        </span>
      </div>
      <ul className='space-y-1'>
        {items.map((t) => (
          <li key={t.text} className='flex items-start gap-2 leading-6'>
            {t.status === 'completed' ? (
              <CircleCheck className='mt-[5px] size-3.5 shrink-0 text-muted-foreground' />
            ) : t.status === 'in_progress' ? (
              <span className='mt-[5px] grid size-3.5 shrink-0 place-items-center rounded-full border border-foreground'>
                <span className='size-1.5 rounded-full bg-foreground' />
              </span>
            ) : (
              <Circle className='mt-[5px] size-3.5 shrink-0 text-muted-foreground/60' />
            )}
            <span
              className={cn(
                t.status === 'completed' &&
                  'text-muted-foreground line-through decoration-muted-foreground/40',
                t.status === 'in_progress' && 'shimmer-text font-medium',
                t.status === 'pending' && 'text-muted-foreground'
              )}
            >
              {t.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
