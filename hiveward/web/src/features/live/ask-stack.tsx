import { useEffect, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** 压在输入框上面的一张待答卡：复核、Agent 问的话、终端菜单 */
export type AskItem = {
  /** 换一件事就换 key：没见过的 key 会把收起的卡重新展开 */
  key: string
  kind: 'review' | 'question'
  /** 收起时那一行的一句话 */
  summary: string
  node: React.ReactNode
}

const storeKey = (handle: string) => `hiveward.asks-collapsed.${handle}`

/** 收起时记下当时有哪几张卡；来了新卡就不算收起 */
function readCollapsed(handle: string): string[] | null {
  try {
    const raw = localStorage.getItem(storeKey(handle))
    const keys: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(keys)
      ? keys.filter((k): k is string => typeof k === 'string')
      : null
  } catch {
    return null
  }
}

function writeCollapsed(handle: string, keys: string[] | null) {
  try {
    if (keys) {
      localStorage.setItem(storeKey(handle), JSON.stringify(keys))
    } else {
      localStorage.removeItem(storeKey(handle))
    }
  } catch {
    // 存不下就只在这次会话里收起
  }
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/**
 * 待答的卡一次只摆一张：好几张时「第 2/3 题」左右翻（键盘 ←/→ 也行），答完一张它从列表里消失，
 * 停在原位就是下一张。能收起成一行不挡对话，收没收起按终端记住；来了新卡自动展开。
 * 卡太高时自己滚，最高占对话区一半。
 */
export function AskStack({
  handle,
  items,
}: {
  handle: string
  items: AskItem[]
}) {
  const [saved, setSaved] = useState(() => readCollapsed(handle))
  const [at, setAt] = useState<{ key?: string; index: number }>({ index: 0 })
  const keys = items.map((i) => i.key)
  const collapsed = !!saved && keys.every((k) => saved.includes(k))
  const found = keys.indexOf(at.key ?? '')
  const index =
    found !== -1 ? found : Math.max(0, Math.min(at.index, items.length - 1))
  const many = items.length > 1

  const go = (delta: number) => {
    const next = (index + delta + items.length) % items.length
    setAt({ key: keys[next], index: next })
  }
  const collapse = (on: boolean) => {
    const next = on ? keys : null
    writeCollapsed(handle, next)
    setSaved(next)
  }

  useEffect(() => {
    if (!many || collapsed) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        typing(e.target) ||
        (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')
      ) {
        return
      }
      e.preventDefault()
      go(e.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (items.length === 0) {
    return null
  }
  const item = items[index]

  if (collapsed) {
    return (
      <div className='shrink-0 px-4 pt-3'>
        <button
          type='button'
          onClick={() => collapse(false)}
          className='mx-auto flex h-9 w-full max-w-[46rem] items-center gap-2 rounded-xl border bg-panel px-3 text-start text-[13px] shadow-sm hover:bg-accent'
        >
          <span className='size-1.5 shrink-0 rounded-full bg-attention' />
          <span className='min-w-0 flex-1 truncate'>{headline(items)}</span>
          <ChevronRight className='size-4 shrink-0 text-muted-foreground' />
        </button>
      </div>
    )
  }

  return (
    <div className='flex max-h-[50%] min-h-0 shrink-0 flex-col px-4 pt-3'>
      <div className='mx-auto flex min-h-0 w-full max-w-[46rem] flex-col'>
        <div className='flex h-7 shrink-0 items-center gap-1 text-xs text-muted-foreground'>
          <button
            type='button'
            onClick={() => collapse(true)}
            className='flex h-6 items-center gap-1 rounded-md px-1.5 hover:bg-accent hover:text-foreground'
          >
            <ChevronDown className='size-3.5' />
            {tr('收起')}
          </button>
          {many && (
            <div className='ms-auto flex items-center gap-0.5'>
              <button
                type='button'
                aria-label={tr('上一件')}
                onClick={() => go(-1)}
                className='grid size-6 place-items-center rounded-md hover:bg-accent hover:text-foreground'
              >
                <ChevronLeft className='size-3.5' />
              </button>
              <span className='min-w-14 text-center tabular-nums'>
                {tr('第 {0}/{1} 件', [index + 1, items.length])}
              </span>
              <button
                type='button'
                aria-label={tr('下一件')}
                onClick={() => go(1)}
                className='grid size-6 place-items-center rounded-md hover:bg-accent hover:text-foreground'
              >
                <ChevronRight className='size-3.5' />
              </button>
            </div>
          )}
        </div>
        <div
          key={item.key}
          className={cn(
            'min-h-0 overflow-x-hidden overflow-y-auto rounded-2xl wrap-anywhere',
            many && 'mt-0.5'
          )}
        >
          {item.node}
        </div>
      </div>
    </div>
  )
}

/** 收起后那一行 */
function headline(items: AskItem[]) {
  if (items.length === 1) {
    const [i] = items
    return i.kind === 'review'
      ? tr('待你复核：{0}', [i.summary])
      : tr('等你回答：{0}', [i.summary])
  }
  return items.every((i) => i.kind === 'review')
    ? tr('有 {0} 件活等你复核', [items.length])
    : tr('有 {0} 个问题等你答', [items.length])
}

/** 汇报的第一句（去掉 Markdown 记号），收起时当一句话用 */
export function firstLine(text: string) {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[#>*+-]+|\d+[.)])\s*/, '').trim())
      .find(Boolean) ?? ''
  return line.replace(/\*\*|__|`/g, '')
}
