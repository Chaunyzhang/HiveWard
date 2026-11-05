import { useQuery } from '@tanstack/react-query'
import type {
  GrokBot,
  GrokBotMessagesResponse,
  GrokBotsResponse,
} from '@shared/api'
import { tr } from '@/lib/i18n'
import type { GrokBotMood } from '@/components/hiveward/grokbot-shape'

/** 本机 Grok Bot 桌面端的缓存（只读、只限本机，不跟着「正在看的电脑」走） */
async function local<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const data: (T & { error?: { message?: string } }) | null = await res
    .json()
    .catch(() => null)
  if (!res.ok || data === null) {
    throw new Error(
      res.status === 404 && !data?.error
        ? tr('后台还没有这个功能')
        : (data?.error?.message ?? `HTTP ${res.status}`)
    )
  }
  return data
}

export function useGrokBots() {
  return useQuery({
    queryKey: ['grok', 'bots'],
    queryFn: () => local<GrokBotsResponse>('/api/grok/bots'),
    refetchInterval: 5_000,
    retry: false,
  })
}

export function useGrokBotMessages(id: string | undefined) {
  return useQuery({
    queryKey: ['grok', 'messages', id],
    queryFn: () =>
      local<GrokBotMessagesResponse>(
        `/api/grok/bots/${encodeURIComponent(id!)}/messages?limit=30`
      ),
    enabled: !!id,
    refetchInterval: 5_000,
    retry: false,
  })
}

/** 头像的表情：等你回复 → 等待；两分钟内有动静 → 干活；其余空闲 */
export function grokMood(bot: GrokBot, now = Date.now()): GrokBotMood {
  if (bot.awaitingYou) {
    return 'waiting'
  }
  const at = bot.lastActivityAt ? Date.parse(bot.lastActivityAt) : 0
  return now - at < 120_000 ? 'working' : 'idle'
}

/** 在 Grok Bot 桌面端里打开这个 Bot 的对话（HiveWard App 只放行这一种链接） */
export const grokBotLink = (id: string) =>
  `grokbot://app/v1/agent?id=${encodeURIComponent(id)}`
