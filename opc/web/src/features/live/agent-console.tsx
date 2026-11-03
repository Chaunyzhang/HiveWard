import { useEffect, useRef, useState } from 'react'
import type { ChatItem, OrcaTerminal, ScreenMenu } from '@shared/api'
import { ArrowUp, Square } from 'lucide-react'
import { toast } from 'sonner'
import { useWorkspace } from '@/stores/workspace'
import {
  agentStatusStyle,
  terminalStatus,
  type AgentStatus,
} from '@/lib/opc-format'
import {
  useOrcaChat,
  useOrcaChoose,
  useOrcaScreen,
  useOrcaSend,
} from '@/lib/orca-live'
import { cn } from '@/lib/utils'
import { useSettledStatus } from '@/hooks/use-settled-status'
import { Textarea } from '@/components/ui/textarea'
import { AgentLogo } from '@/components/opc/agent-logo'
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
  menu,
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
  /** Agent 停在选择菜单上时的选项条，压在输入框上面，哪一档都看得到 */
  menu?: React.ReactNode
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
  const [mode, setMode] = useState<'chat' | 'terminal' | null>(null)
  const modes = [...(chat ? (['chat'] as const) : []), 'terminal' as const]
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
  // 真终端自己收键盘，输入框只在对话 / 文字画面时出现
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
                {{ chat: '对话', terminal: '终端' }[v]}
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

      {view === 'chat' ? (
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

      {menu}

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
 * 关终端在主页「现场」标签的 ×，或者像原生终端一样在里面 exit。中间栏点开 Agent 时用它。
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
  useFocusAgent(t.handle)
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
            : screen.data?.menu
              ? '等待 · 要你选'
              : status === 'waiting'
                ? '等待 · 要你确认'
                : '空闲 · 等你说话'
      }
      menu={
        screen.data?.menu && (
          <MenuBar handle={t.handle} menu={screen.data.menu} />
        )
      }
      context={context}
      chat={hasChat ? (chat.data?.items ?? []) : null}
      terminal={t.handle}
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

/** Agent 停在选择菜单上（Kimi 计划要批准等）：问话 + 每项一个按钮，点了替它在终端里按下去 */
function MenuBar({ handle, menu }: { handle: string; menu: ScreenMenu }) {
  const choose = useOrcaChoose(handle)
  return (
    <div className='shrink-0 space-y-2 border-t bg-attention/5 px-4 py-3'>
      <p className='text-xs text-attention'>Agent 在等你选：{menu.question}</p>
      <div className='flex flex-wrap gap-2'>
        {menu.options.map((o) => (
          <button
            key={o.n}
            type='button'
            disabled={choose.isPending}
            onClick={() =>
              choose.mutate(o.n, {
                onError: (e) => toast.error(`没选上：${e.message}`),
              })
            }
            className={cn(
              'h-8 rounded-md px-3 text-xs disabled:opacity-50',
              o.n === menu.cursor
                ? 'bg-foreground text-background'
                : 'border hover:bg-accent'
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 中间栏正在看这个终端：右栏的浏览器跟着显示它开的网页；不看了就清掉 */
export function useFocusAgent(handle: string | undefined) {
  const setAgent = useWorkspace((s) => s.setAgent)
  useEffect(() => {
    if (!handle) {
      return
    }
    setAgent(handle)
    return () => setAgent(null)
  }, [handle, setAgent])
}
