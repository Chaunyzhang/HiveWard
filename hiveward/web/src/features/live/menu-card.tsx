import { useState } from 'react'
import type { ScreenMenu } from '@shared/api'
import { toast } from 'sonner'
import { useHiveWardChoose } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { FREE_KEY, QuestionCard } from '@/components/hiveward/question-card'

/**
 * Claude 一次问几道题时，提问框顶上有一排题签：「←  ☐ 部署  ☒ 域名  ✔ Submit  →」。
 * 认出来就返回共几道、现在第几道（第一个还没答的 ☐）；不是这种画面返回 null。
 */
export function menuProgress(screen?: string) {
  const bar = screen
    ?.split('\n')
    .find((l) => (l.match(/[☐☒✔]\s*\S/gu)?.length ?? 0) >= 2)
  if (!bar) {
    return null
  }
  const chips = [...bar.matchAll(/([☐☒✔])\s*(.+?)(?=\s{2,}|\s*[☐☒✔→]|$)/gu)]
    .map((m) => ({ mark: m[1], label: m[2].trim() }))
    .filter((c) => !(c.mark === '✔' && /submit|提交/i.test(c.label)))
  const current = chips.findIndex((c) => c.mark === '☐')
  return chips.length >= 2
    ? { total: chips.length, current: current === -1 ? null : current + 1 }
    : null
}

/**
 * Agent 停在选择菜单上（Claude 提问、权限确认、Kimi 计划要批准）：压在输入框上面的提问卡片。
 * 点一项或按它的数字键，就替 Agent 在终端里选下去；「自己写」那项写完回车。
 */
export function MenuCard({
  handle,
  menu,
  screen,
}: {
  handle: string
  menu: ScreenMenu
  /** 终端画面：认一次问了几道题 */
  screen?: string
}) {
  const progress = menuProgress(screen)
  const choose = useHiveWardChoose(handle)
  const [picked, setPicked] = useState<string | null>(null)
  const free = menu.options.find((o) => o.free)
  const send = (n: number, key: string, text?: string) => {
    if (choose.isPending) {
      return
    }
    setPicked(key)
    choose.mutate(
      { n, text },
      {
        onError: (e) => {
          setPicked(null)
          toast.error(tr('没选上：{0}', [e.message]))
        },
      }
    )
  }

  return (
    <QuestionCard
      meta={
        progress &&
        (progress.current
          ? tr('它一次问了 {0} 道题 · 第 {1} 道，答完自动到下一道', [
              progress.total,
              progress.current,
            ])
          : tr('{0} 道题都答了，确认后一起交给它', [progress.total]))
      }
      title={menu.title}
      question={menu.question}
      options={menu.options
        .filter((o) => !o.free)
        .map((o) => ({
          key: String(o.n),
          label: o.label,
          description: o.description,
          recommended: o.recommended,
        }))}
      freeText={free ? tr('都不是，自己写…') : undefined}
      picked={picked}
      busy={choose.isPending}
      hotkeys
      onPick={(key) => send(Number(key), key)}
      onFreeText={(text) => free && send(free.n, FREE_KEY, text)}
    />
  )
}
