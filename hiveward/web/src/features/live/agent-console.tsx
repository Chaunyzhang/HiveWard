import { useEffect, useRef, useState } from 'react'
import type { ChatItem, HiveWardChat, HiveWardTerminal } from '@shared/api'
import { ArrowLeft, ArrowUp, Square } from 'lucide-react'
import { toast } from 'sonner'
import { useWorkspace } from '@/stores/workspace'
import {
  agentStatusStyle,
  backgroundNote,
  errorStopText,
  terminalStatus,
  terminalTitle,
  type AgentStatus,
} from '@/lib/hiveward-format'
import {
  useHiveWardChat,
  useHiveWardImageUpload,
  useHiveWardScreen,
  useHiveWardSend,
  useQuota,
} from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useSettledStatus } from '@/hooks/use-settled-status'
import { Textarea } from '@/components/ui/textarea'
import { AgentLogo } from '@/components/hiveward/agent-logo'
import { PaneHeader, useDocked } from '@/components/layout/top-bar-slot'
import { useSeatTitle } from '@/features/session/use-seat-title'
import { TerminalView } from '@/features/terminal/terminal-view'
import { type AskItem, AskStack } from './ask-stack'
import { ChatView } from './chat-view'
import { MenuCard } from './menu-card'
import { PastedImages, usePastedImages } from './pasted-images'

/**
 * 控制台外壳：标题栏 + 实时输出（对话 / 终端两种看法）+ 输入框。
 * 有终端 handle 时「终端」一档就是真终端（直接在里面打字、按 Esc），输入框收起；
 * 「对话」一档的输入框像原生 Agent：干活中发送键变成停止，Esc 也是停止。
 */
export function ConsoleView({
  leading,
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
  uploadImage,
  onInterrupt,
  sending,
  className,
  headerClassName,
  trailing,
  readOnly,
  loading,
  plan,
  background,
}: {
  /** 标题最前面的东西（中间栏打开时是返回箭头） */
  leading?: React.ReactNode
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
  /** Agent 停在选择菜单上时的提问卡片，压在输入框上面，哪一档都看得到 */
  menu?: React.ReactNode
  working: boolean
  placeholder: string
  /** 不传则输入框禁用；done() 在发出去后清空输入；images 是贴进来的图存好的路径 */
  onSend?: (text: string, done: () => void, images: string[]) => void
  /** 传了才能往输入框里贴图：把一张图存好，返回它的路径 */
  uploadImage?: (file: Blob) => Promise<string>
  /** 让 Agent 停下（Esc / 干活中点发送键） */
  onInterrupt?: () => void
  sending?: boolean
  className?: string
  /** 放进抽屉时给右上角的关闭按钮让位 */
  headerClassName?: string
  /** 标题行最右边（会话工具栏） */
  trailing?: React.ReactNode
  /** 只能看、不能在这里说话（会话的输入框在别的 App 里）：输入框的位置换成这句说明 */
  readOnly?: React.ReactNode
  /** 对话记录还在读：先空着，别把终端闪出来再跳回对话 */
  loading?: boolean
  /** Agent 自己列的任务清单 */
  plan?: HiveWardChat['plan']
  /** 「后台 N 个命令在跑」：主 Agent 停了、后台命令还在跑，写在对话最底下；状态照旧 */
  background?: string
}) {
  const [mode, setMode] = useState<'chat' | 'terminal' | null>(null)
  // 没有终端也没有画面（只读的外部会话）时不给「终端」这一档
  const modes = [
    ...(chat ? (['chat'] as const) : []),
    ...(terminal || screen !== undefined ? (['terminal'] as const) : []),
  ]
  const view = mode && modes.includes(mode) ? mode : chat ? 'chat' : 'terminal'
  const [text, setText] = useState('')
  const pasted = usePastedImages(uploadImage)
  const pre = useRef<HTMLPreElement>(null)

  // 画面更新时贴底，像真终端一样
  useEffect(() => {
    const el = pre.current
    if (el) el.scrollTop = el.scrollHeight
  }, [screen, view])

  const submit = () => {
    const value = text.trim()
    if ((value || pasted.paths.length) && !pasted.uploading && onSend) {
      onSend(
        value,
        () => {
          setText('')
          pasted.clear()
        },
        pasted.paths
      )
    }
  }
  // 干活中、没打字也没贴图时，发送键就是停止键
  const stoppable =
    working && !!onInterrupt && !text.trim() && !pasted.images.length
  // 真终端自己收键盘，输入框只在对话 / 文字画面时出现
  const nativeTerminal = view === 'terminal' && !!terminal

  return (
    <section
      className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden', className)}
    >
      <PaneHeader className={cn('gap-3', headerClassName)}>
        <div className='flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden'>
          {leading}
          <AgentLogo agent={agent} className='size-4 shrink-0' />
          <h2 className='max-w-full min-w-16 shrink truncate text-[13px] font-medium'>
            {title}
          </h2>
          {subtitle && (
            <span className='min-w-0 shrink truncate text-xs text-muted-foreground'>
              {subtitle}
            </span>
          )}
          <span
            className={cn(
              'flex max-w-64 min-w-0 shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground',
              tone === 'failed' && 'text-danger',
              tone === 'quota' && 'text-attention'
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                agentStatusStyle[tone].dot,
                tone === 'working' && 'animate-pulse'
              )}
            />
            <span className='truncate' title={status}>
              {status}
            </span>
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
                {{ chat: tr('对话'), terminal: tr('终端') }[v]}
              </button>
            ))}
          </div>
        )}
        {trailing}
      </PaneHeader>

      {context && (
        <div className='flex shrink-0 items-center gap-2 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground'>
          {context}
        </div>
      )}

      {loading && !mode ? (
        <div className='min-h-0 flex-1' />
      ) : view === 'chat' ? (
        <ChatView
          items={chat ?? []}
          working={working}
          agent={agent}
          plan={plan}
        />
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

      {background && view === 'chat' && (
        <p className='mx-auto flex w-full max-w-[46rem] shrink-0 items-center gap-2 px-6 pb-1 text-[13px] text-muted-foreground'>
          <span className='size-1.5 rounded-full bg-muted-foreground/40' />
          {background}
        </p>
      )}

      {menu}

      {readOnly && !nativeTerminal && (
        <footer className='shrink-0 px-4 pt-2 pb-4'>
          <div className='mx-auto w-full max-w-[46rem] rounded-2xl border border-dashed px-4 py-3 text-center text-[13px] text-muted-foreground'>
            {readOnly}
          </div>
        </footer>
      )}

      {!readOnly && !nativeTerminal && (
        // 输入框像桌面端：圆角框里一个不带边框的输入区，发送 / 停止是框里右下角的圆按钮
        <footer className='shrink-0 px-4 pt-2 pb-4'>
          <div className='mx-auto flex w-full max-w-[46rem] flex-col rounded-2xl border bg-panel py-1.5 ps-3 pe-1.5 shadow-sm transition-colors focus-within:border-foreground/25'>
            {pasted.images.length > 0 && (
              <PastedImages images={pasted.images} onRemove={pasted.remove} />
            )}
            <div className='flex items-end gap-2'>
              <Textarea
                value={text}
                disabled={!onSend}
                onChange={(e) => setText(e.target.value)}
                onPaste={uploadImage ? pasted.onPaste : undefined}
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
                className='max-h-40 min-h-8 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 text-[14px] shadow-none focus-visible:ring-0 md:text-[14px] dark:bg-transparent'
              />
              {stoppable ? (
                <button
                  type='button'
                  onClick={onInterrupt}
                  title={tr('停下（Esc）')}
                  aria-label={tr('停下')}
                  className='grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background'
                >
                  <Square className='size-3 fill-current' />
                </button>
              ) : (
                <button
                  type='button'
                  onClick={submit}
                  title={tr('发送（Enter）')}
                  aria-label={tr('发送')}
                  disabled={
                    !onSend ||
                    (!text.trim() && !pasted.paths.length) ||
                    pasted.uploading ||
                    sending
                  }
                  className='grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background disabled:opacity-20'
                >
                  <ArrowUp className='size-4' />
                </button>
              )}
            </div>
          </div>
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
  leading,
  context,
  className,
  headerClassName,
  trailing,
  focus = true,
  asks,
  title,
}: {
  terminal: HiveWardTerminal
  /** 标题：从架构图节点打开时传它的职位（外援写外援的出处）；不传按终端找它坐的位子 */
  title?: string
  leading?: React.ReactNode
  context?: React.ReactNode
  className?: string
  headerClassName?: string
  trailing?: React.ReactNode
  /** 中间栏的主会话：右栏浏览器跟着它；侧边对话传 false */
  focus?: boolean
  /** 在等你定的事（交活待复核、它问你的话），和终端菜单一起压在输入框上面 */
  asks?: AskItem[]
}) {
  const screen = useHiveWardScreen(t.handle)
  const chat = useHiveWardChat(t.handle)
  const send = useHiveWardSend(t.handle)
  const uploadImage = useHiveWardImageUpload()
  // 列表里认出的「干活中」也算（Kimi 不报状态，列表和画面都靠转圈判断，谁先看到算谁）
  const agent =
    screen.data?.agent && t.status === 'working'
      ? 'working'
      : screen.data?.agent
  const live = useSettledStatus(terminalStatus(agent))
  // 停着、屏幕底部是模型服务报错：额度用完单独一种颜色，别的算故障
  const stop = live === 'working' ? undefined : screen.data?.errorStop
  const status = stop ? (stop.reason === 'quota' ? 'quota' : 'failed') : live
  const resetsAt = useQuota().data?.providers.find(
    (p) => p.agent === t.agent
  )?.resetsAt
  const dropped = screen.data?.dropped
  useFocusAgent(focus ? t.handle : undefined)
  // 坐在座位上的写它的职位，终端自己的标题（多半是手上的活）挪到旁边
  const seats = useSeatTitle()
  const background = backgroundNote(
    screen.data?.backgroundCommands ?? t.backgroundCommands
  )
  const seat = title ?? seats.ofTerminal(t.handle)
  // 只有终端里在跑 Agent、且找到了它的对话记录，才有对话可看；普通 shell 只有终端
  const hasChat = !!chat.data?.source

  return (
    <ConsoleView
      leading={leading}
      agent={t.agent}
      title={seat ?? (t.title || tr('终端'))}
      subtitle={seat && terminalTitle(t.title)}
      tone={status}
      status={
        !agent
          ? tr('普通终端，没有 Agent 在跑')
          : stop
            ? errorStopText(stop, resetsAt)
            : status === 'working'
              ? tr('干活')
              : screen.data?.menu
                ? tr('等待 · 要你选')
                : status === 'waiting'
                  ? tr('等待 · 要你确认')
                  : tr('空闲 · 等你说话')
      }
      menu={
        <AskStack
          handle={t.handle}
          items={[
            ...(asks ?? []),
            ...(screen.data?.menu
              ? [
                  {
                    // 一次问几道题时每道题的问话不同：换题就算新卡
                    key: `menu:${screen.data.menu.question}`,
                    kind: 'question' as const,
                    summary: screen.data.menu.question,
                    node: (
                      <MenuCard
                        handle={t.handle}
                        menu={screen.data.menu}
                        screen={screen.data.text}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />
      }
      context={
        dropped?.length ? (
          <>
            <span className='min-w-0 truncate text-attention'>
              {tr('上级发的消息因为出错被丢了，恢复后要重发：{0}', [
                dropped.join(' / '),
              ])}
            </span>
            {context}
          </>
        ) : (
          context
        )
      }
      chat={hasChat ? (chat.data?.items ?? []) : null}
      plan={chat.data?.plan}
      background={background}
      loading={chat.isPending}
      terminal={t.handle}
      working={status === 'working'}
      placeholder={
        agent != null
          ? tr('对 Agent 说…（Enter 发送，Shift+Enter 换行）')
          : tr('输入命令…（Enter 执行）')
      }
      uploadImage={agent != null ? uploadImage : undefined}
      onSend={(text, done, images) =>
        send.mutate(
          {
            text,
            agentPrompt: agent != null ? true : undefined,
            images: images.length ? images : undefined,
          },
          {
            onSuccess: done,
            onError: (e) => toast.error(tr('没发出去：{0}', [e.message])),
          }
        )
      }
      onInterrupt={() => send.mutate({ interrupt: true })}
      sending={send.isPending}
      className={className}
      headerClassName={headerClassName}
      trailing={trailing}
    />
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

/** 中间栏标题行最前面的返回箭头：回到结构上的上一级（打开它的那个主页） */
export function BackButton({ onClick }: { onClick: () => void }) {
  // 挂进顶栏时顶栏有前进后退，这里不再放
  if (useDocked()) {
    return null
  }
  return (
    <button
      type='button'
      title={tr('返回上一级')}
      aria-label={tr('返回上一级')}
      onClick={onClick}
      className='-ms-1.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
    >
      <ArrowLeft className='size-4' />
    </button>
  )
}
