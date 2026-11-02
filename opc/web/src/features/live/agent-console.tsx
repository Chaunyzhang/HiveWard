import { useEffect, useRef, useState } from 'react'
import type { ChatItem, OrcaTerminal } from '@shared/api'
import { ArrowUp, Square } from 'lucide-react'
import { toast } from 'sonner'
import {
  useBrowser,
  useBrowserViewport,
  type BrowserControl,
  type BrowserTab,
} from '@/lib/desktop'
import {
  agentStatusStyle,
  terminalStatus,
  type AgentStatus,
} from '@/lib/opc-format'
import { useOrcaChat, useOrcaScreen, useOrcaSend } from '@/lib/orca-live'
import { cn } from '@/lib/utils'
import { useSettledStatus } from '@/hooks/use-settled-status'
import { Textarea } from '@/components/ui/textarea'
import { AgentLogo } from '@/components/opc/agent-logo'
import { RemoteViewport } from '@/features/browser'
import { TerminalView } from '@/features/terminal/terminal-view'
import { ChatView } from './chat-view'

/**
 * 控制台外壳：标题栏 + 实时输出（对话 / 终端两种看法）+ 输入框。
 * 有终端 handle 时「终端」一档就是真终端（直接在里面打字、按 Esc），输入框收起；
 * 「对话」一档的输入框像原生 Agent：干活中发送键变成停止，Esc 也是停止。
 */
export function ConsoleView({
  agent,
  title,
  subtitle,
  tone,
  status,
  context,
  chat,
  terminal,
  screen,
  browser,
  working,
  placeholder,
  onSend,
  onInterrupt,
  sending,
  className,
  headerClassName,
}: {
  /** 是哪家的 Agent：标题前画它的 logo */
  agent?: string | null
  title: string
  subtitle?: React.ReactNode
  tone: AgentStatus
  status: string
  /** 标题栏下面一行说明（所属业务、手上任务…） */
  context?: React.ReactNode
  /** 对话记录；null 表示没有，只能看终端 */
  chat: ChatItem[] | null
  /** 直连的终端：「终端」一档显示真终端；没有时显示 screen 的文字画面 */
  terminal?: string
  screen?: React.ReactNode
  /** 这个 Agent 正在用的浏览器页面（有才出现「浏览器」这一档） */
  browser?: React.ReactNode
  working: boolean
  placeholder: string
  /** 不传则输入框禁用；done() 在发出去后清空输入 */
  onSend?: (text: string, done: () => void) => void
  /** 让 Agent 停下（Esc / 干活中点发送键） */
  onInterrupt?: () => void
  sending?: boolean
  className?: string
  /** 放进抽屉时给右上角的关闭按钮让位 */
  headerClassName?: string
}) {
  const [mode, setMode] = useState<'chat' | 'terminal' | 'browser' | null>(null)
  const modes = [
    ...(chat ? (['chat'] as const) : []),
    'terminal' as const,
    ...(browser ? (['browser'] as const) : []),
  ]
  const view = mode && modes.includes(mode) ? mode : chat ? 'chat' : 'terminal'
  const [text, setText] = useState('')
  const pre = useRef<HTMLPreElement>(null)

  // 画面更新时贴底，像真终端一样
  useEffect(() => {
    const el = pre.current
    if (el) el.scrollTop = el.scrollHeight
  }, [screen, view])

  const submit = () => {
    const value = text.trim()
    if (value && onSend) onSend(value, () => setText(''))
  }
  // 干活中、没打字时，发送键就是停止键
  const stoppable = working && !!onInterrupt && !text.trim()
  // 真终端自己收键盘，输入框只在对话 / 浏览器 / 文字画面时出现
  const nativeTerminal = view === 'terminal' && !!terminal

  return (
    <section
      className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden', className)}
    >
      <header
        className={cn(
          'flex h-12 shrink-0 items-center gap-3 px-4',
          headerClassName
        )}
      >
        <div className='flex min-w-0 flex-1 items-center gap-2.5'>
          <AgentLogo agent={agent} className='size-4 shrink-0' />
          <h2 className='min-w-0 shrink truncate text-[13px] font-medium'>
            {title}
          </h2>
          {subtitle && (
            <span className='min-w-0 shrink-[2] truncate text-xs text-muted-foreground'>
              {subtitle}
            </span>
          )}
          <span className='flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground'>
            <span
              className={cn(
                'size-1.5 rounded-full',
                agentStatusStyle[tone].dot,
                tone === 'working' && 'animate-pulse'
              )}
            />
            {status}
          </span>
        </div>
        {modes.length > 1 && (
          <div className='flex shrink-0 rounded-md bg-muted p-0.5'>
            {modes.map((v) => (
              <button
                key={v}
                type='button'
                onClick={() => setMode(v)}
                className={cn(
                  'h-6 rounded-[5px] px-2.5 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground',
                  view === v && 'bg-panel text-foreground shadow-sm'
                )}
              >
                {{ chat: '对话', terminal: '终端', browser: '浏览器' }[v]}
              </button>
            ))}
          </div>
        )}
      </header>

      {context && (
        <div className='flex shrink-0 items-center gap-2 border-y bg-muted/30 px-4 py-2 text-xs text-muted-foreground'>
          {context}
        </div>
      )}

      {view === 'browser' ? (
        browser
      ) : view === 'chat' ? (
        <ChatView items={chat ?? []} working={working} />
      ) : terminal ? (
        <TerminalView handle={terminal} className='flex-1' />
      ) : (
        <pre
          ref={pre}
          className='min-h-0 flex-1 overflow-auto bg-background/60 px-4 py-3 font-mono text-[12px] leading-[1.45] whitespace-pre text-foreground/90'
        >
          {screen}
        </pre>
      )}

      {!nativeTerminal && (
        <footer className='flex shrink-0 items-end gap-2 p-3'>
          <Textarea
            value={text}
            disabled={!onSend}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && working && onInterrupt) {
                e.preventDefault()
                onInterrupt()
              } else if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={placeholder}
            rows={1}
            className='max-h-40 min-h-9 flex-1 resize-none py-2 text-[13px] md:text-[13px]'
          />
          {stoppable ? (
            <button
              type='button'
              onClick={onInterrupt}
              title='停下（Esc）'
              aria-label='停下'
              className='grid size-9 shrink-0 place-items-center rounded-md bg-foreground text-background'
            >
              <Square className='size-3.5 fill-current' />
            </button>
          ) : (
            <button
              type='button'
              onClick={submit}
              title='发送（Enter）'
              aria-label='发送'
              disabled={!onSend || !text.trim() || sending}
              className='grid size-9 shrink-0 place-items-center rounded-md bg-foreground text-background disabled:opacity-30'
            >
              <ArrowUp className='size-4' />
            </button>
          )}
        </footer>
      )}
    </section>
  )
}

/**
 * 一个终端的控制台：默认看对话（Agent 自己的对话记录），可切到真终端；对话下面的输入框直接对它说话。
 * 关终端在项目页终端标签的 ×，或者像原生终端一样在里面 exit。现场页和架构图的详情抽屉共用。
 */
export function AgentConsole({
  terminal: t,
  context,
  className,
  headerClassName,
}: {
  terminal: OrcaTerminal
  context?: React.ReactNode
  className?: string
  headerClassName?: string
}) {
  const screen = useOrcaScreen(t.handle)
  const chat = useOrcaChat(t.handle)
  const send = useOrcaSend(t.handle)
  // 列表里认出的「干活中」也算（Kimi 不报状态，列表和画面都靠转圈判断，谁先看到算谁）
  const agent =
    screen.data?.agent && t.status === 'working'
      ? 'working'
      : screen.data?.agent
  const status = useSettledStatus(terminalStatus(agent))
  const browser = useBrowser()
  const pages = browser.tabs.filter((b) => b.by === t.handle)
  // 只有终端里在跑 Agent、且找到了它的对话记录，才有对话可看；普通 shell 只有终端
  const hasChat = !!chat.data?.source

  return (
    <ConsoleView
      agent={t.agent}
      title={t.title || '终端'}
      subtitle={t.project}
      tone={status}
      status={
        !agent
          ? '普通终端，没有 Agent 在跑'
          : status === 'working'
            ? '干活'
            : status === 'waiting'
              ? '等待 · 要你确认'
              : '空闲 · 等你说话'
      }
      context={context}
      chat={hasChat ? (chat.data?.items ?? []) : null}
      terminal={t.handle}
      browser={
        pages.length && browser.control ? (
          <AgentBrowser
            tabs={pages}
            control={browser.control}
            remote={browser.remote}
          />
        ) : undefined
      }
      working={status === 'working'}
      placeholder={
        agent != null
          ? '对 Agent 说…（Enter 发送，Shift+Enter 换行）'
          : '输入命令…（Enter 执行）'
      }
      onSend={(text, done) =>
        send.mutate(
          { text, agentPrompt: agent != null ? true : undefined },
          {
            onSuccess: done,
            onError: (e) => toast.error(`没发出去：${e.message}`),
          }
        )
      }
      onInterrupt={() => send.mutate({ interrupt: true })}
      sending={send.isPending}
      className={className}
      headerClassName={headerClassName}
    />
  )
}

/** Agent 正在用的网页：真浏览器叠在这里，看着它点，也能自己接手 */
function AgentBrowser({
  tabs,
  control,
  remote,
}: {
  tabs: BrowserTab[]
  control: BrowserControl
  remote: boolean
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const tab =
    tabs.find((t) => t.id === picked) ??
    [...tabs].sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0]
  const ref = useBrowserViewport(!remote)
  // 切到这一档就把它设成正在显示的页面（别的电脑上的看截图，不用切）
  useEffect(() => {
    if (!remote && tab && !tab.active) control.activate(tab.id)
  }, [tab, remote, control])
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className='flex h-9 shrink-0 items-center gap-2 border-y bg-muted/30 px-4 text-xs text-muted-foreground'>
        {tabs.length > 1 ? (
          <select
            value={tab.id}
            onChange={(e) => setPicked(e.target.value)}
            className='h-6 max-w-64 rounded bg-transparent text-xs'
          >
            {tabs.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title || t.url}
              </option>
            ))}
          </select>
        ) : (
          <span className='truncate text-foreground/80'>{tab.title}</span>
        )}
        <span className='truncate font-mono'>{tab.url}</span>
        {tab.loading && (
          <span className='ms-auto size-1.5 shrink-0 animate-pulse rounded-full bg-live' />
        )}
      </div>
      {remote ? (
        <RemoteViewport tab={tab} />
      ) : (
        <div ref={ref} className='min-h-0 flex-1 bg-white' />
      )}
    </div>
  )
}
