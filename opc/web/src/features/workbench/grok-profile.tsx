import { useState } from 'react'
import type { GrokBot, GrokBotMessage, Task } from '@shared/api'
import { ExternalLink, Paperclip, Phone } from 'lucide-react'
import {
  grokBotLink,
  grokMood,
  useGrokBotMessages,
  useGrokBots,
} from '@/lib/grok'
import { timeAgo } from '@/lib/opc-format'
import { cn } from '@/lib/utils'
import { GrokBotAvatar } from '@/components/opc/grokbot-avatar'
import { Markdown } from '@/features/live/chat-view'
import { TaskList } from './dispatched-tasks'

const dateFmt = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})

/**
 * Grok Bot 的「个人主页」：点架构图上的 Grok Bot 头像在右侧打开。
 * 上面一排是这台电脑上的所有 Bot，下面是选中那个的大头像、资料、最近对话（只读）和它派给 Agent 的活。
 * 要跟它说话回 Grok Bot 里——它没有公开接口，HiveWard 只读它在本机的缓存。
 */
export function GrokProfile({ tasks }: { tasks: Task[] }) {
  const { data, error, isLoading } = useGrokBots()
  const bots = data?.bots ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const bot = bots.find((b) => b.id === picked) ?? bots[0]

  if (isLoading) {
    return (
      <p className='p-8 text-[13px] text-muted-foreground'>读取 Grok Bot…</p>
    )
  }
  if (error) {
    return (
      <p className='p-8 text-[13px] text-danger'>
        读不到 Grok Bot：{error.message}
      </p>
    )
  }
  if (!data?.installed) {
    return (
      <p className='p-8 text-[13px] text-muted-foreground'>
        这台电脑没装 Grok Bot。
      </p>
    )
  }
  if (!bot) {
    return (
      <p className='p-8 text-[13px] text-muted-foreground'>
        Grok Bot 里还没有 Bot{data.signedIn ? '' : '（还没登录）'}。
      </p>
    )
  }

  return (
    <div className='flex h-full min-h-0 flex-col overflow-y-auto'>
      {bots.length > 1 && (
        <nav className='flex shrink-0 items-center gap-1 overflow-x-auto px-6 pt-4'>
          {bots.map((b) => (
            <button
              key={b.id}
              type='button'
              title={b.name}
              onClick={() => setPicked(b.id)}
              className={cn(
                'relative grid size-9 shrink-0 place-items-center rounded-full hover:bg-accent',
                b.id === bot.id && 'bg-accent ring-1 ring-border'
              )}
            >
              <GrokBotAvatar seed={b.id} look={b} className='size-6' />
              {(b.unreadCount > 0 || b.awaitingYou) && (
                <span className='absolute end-1 top-1 size-2 rounded-full bg-attention ring-2 ring-background' />
              )}
            </button>
          ))}
        </nav>
      )}
      <Profile key={bot.id} bot={bot} running={data.running} tasks={tasks} />
    </div>
  )
}

function Profile({
  bot,
  running,
  tasks,
}: {
  bot: GrokBot
  running: boolean
  tasks: Task[]
}) {
  const mood = grokMood(bot)
  return (
    <div className='mx-auto w-full max-w-2xl px-6 pb-10'>
      <header className='flex flex-col items-center pt-8 pb-6 text-center'>
        <GrokBotAvatar
          seed={bot.id}
          look={bot}
          mood={mood}
          animate
          className='size-28'
        />
        <h1 className='mt-5 text-2xl font-semibold'>{bot.name}</h1>
        <p className='mt-1.5 flex flex-wrap items-center justify-center gap-x-2 text-xs text-muted-foreground'>
          <span className='flex items-center gap-1.5'>
            <span
              className={cn(
                'size-1.5 rounded-full',
                running ? 'bg-live' : 'bg-muted-foreground/40'
              )}
            />
            {running ? 'Grok Bot 开着' : 'Grok Bot 没开'}
          </span>
          {bot.awaitingYou && (
            <span className='text-attention'>· 在等你回复</span>
          )}
          {bot.unreadCount > 0 && (
            <span className='text-attention'>· {bot.unreadCount} 条未读</span>
          )}
          {bot.lastActivityAt && (
            <span>· {timeAgo(bot.lastActivityAt)}有动静</span>
          )}
        </p>
        {bot.description && (
          <p className='mt-4 max-w-xl text-[13px] leading-6 whitespace-pre-line text-foreground/80'>
            {bot.description}
          </p>
        )}
        <p className='mt-3 text-[11px] text-muted-foreground'>
          {dateFmt.format(new Date(bot.createdAt))}创建
          {bot.voice && <> · 语音 {bot.voice}</>}
        </p>
        <a
          href={grokBotLink(bot.id)}
          target='_blank'
          rel='noreferrer'
          className='mt-5 flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3.5 text-xs text-background'
        >
          在 Grok Bot 里打开
          <ExternalLink className='size-3.5' />
        </a>
      </header>

      <Messages bot={bot} />

      {tasks.length > 0 && (
        <section className='mt-10'>
          <h2 className='mb-2 text-[13px] font-medium'>派给 Agent 的活</h2>
          <TaskList tasks={tasks} />
        </section>
      )}
    </div>
  )
}

/** 最近的对话，只读；旧的在上。主页先看人，不自动滚到底 */
function Messages({ bot }: { bot: GrokBot }) {
  const { data, error, isLoading } = useGrokBotMessages(bot.id)
  const list = data?.messages ?? []

  return (
    <section className='border-t pt-6'>
      <h2 className='mb-1 text-[13px] font-medium'>最近对话</h2>
      <p className='mb-4 text-[11px] text-muted-foreground'>
        Grok Bot 在这台电脑上只留最近一段；要回它，点上面在 Grok Bot 里打开。
      </p>
      {isLoading ? (
        <p className='text-xs text-muted-foreground'>读取对话…</p>
      ) : error ? (
        <p className='text-xs text-danger'>读不到对话：{error.message}</p>
      ) : list.length === 0 ? (
        <p className='text-xs text-muted-foreground'>
          这台电脑上没有它的对话记录。
        </p>
      ) : (
        <ol className='space-y-4'>
          {list.map((m) => (
            <Message key={m.id} message={m} bot={bot} />
          ))}
        </ol>
      )}
    </section>
  )
}

function Message({
  message: m,
  bot,
}: {
  message: GrokBotMessage
  bot: GrokBot
}) {
  if (m.from === 'you') {
    return (
      <li className='flex justify-end'>
        <div className='max-w-[80%] rounded-2xl bg-muted px-3.5 py-2 text-[13px] leading-6'>
          {m.kind === 'attachment' ? (
            <span className='flex items-center gap-1.5'>
              <Paperclip className='size-3.5 shrink-0' />
              {m.text}
            </span>
          ) : (
            <span className='whitespace-pre-wrap'>{m.text}</span>
          )}
        </div>
      </li>
    )
  }
  return (
    <li className='flex gap-2.5'>
      <GrokBotAvatar seed={bot.id} look={bot} className='mt-1 size-4' />
      <div className='min-w-0 flex-1 text-[13px] leading-6 text-foreground/90'>
        {m.kind === 'call' ? (
          <span className='flex items-center gap-1.5 text-muted-foreground'>
            <Phone className='size-3.5 shrink-0' />
            {m.text}
          </span>
        ) : (
          <Markdown text={m.text} />
        )}
        {m.kind === 'choice' && m.options && (
          <div className='mt-2 flex flex-wrap gap-1.5'>
            {m.options.map((o) => (
              <span
                key={o}
                className='rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground'
              >
                {o}
              </span>
            ))}
          </div>
        )}
        <p className='mt-1 text-[11px] text-muted-foreground'>
          {timeAgo(m.at)}
        </p>
      </div>
    </li>
  )
}
