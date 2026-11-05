import { useEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle } from 'lucide-react'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** 自己写那行在送出时的 picked 值 */
export const FREE_KEY = '__free__'

export type QuestionOption = {
  key: string
  label: string
  description?: string
  recommended?: boolean
}

/**
 * Agent 问你话时的卡片，排成 Claude 桌面端那样：小标题、完整的问题，选项竖排、每项带编号和说明，
 * 推荐的那项挂「推荐」，最后一行可以自己写。对话页（终端停在菜单上）和任务页的待决策共用。
 * 点哪项由外面决定怎么送出去；picked 是正在送出的那项（转圈）。
 */
export function QuestionCard({
  title,
  question,
  meta,
  body,
  options,
  freeText,
  picked,
  busy,
  hotkeys,
  footer,
  onPick,
  onFreeText,
  className,
}: {
  title?: string
  /** 不传时只有 body（交活复核：汇报就是正文） */
  question?: string
  /** 问题上面一行灰字（哪块业务、多久前） */
  meta?: React.ReactNode
  /** 问题下面的补充：说明文字、截图 */
  body?: React.ReactNode
  options: QuestionOption[]
  /** 有这项时最后一行是「自己写」输入框；值是占位文字 */
  freeText?: string
  picked?: string | null
  busy?: boolean
  /** 数字键直接选（页面上只有一张卡时开） */
  hotkeys?: boolean
  footer?: React.ReactNode
  onPick: (key: string) => void
  onFreeText?: (text: string) => void
  className?: string
}) {
  const [note, setNote] = useState('')
  const input = useRef<HTMLInputElement>(null)

  // 数字键直接选（焦点在输入框、终端里时不抢）
  useEffect(() => {
    if (!hotkeys) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      const target = e.target
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        busy ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)))
      ) {
        return
      }
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1) {
        return
      }
      if (n <= options.length) {
        e.preventDefault()
        onPick(options[n - 1].key)
      } else if (n === options.length + 1 && freeText !== undefined) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkeys, busy, options, freeText, onPick])

  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border bg-panel shadow-sm',
        className
      )}
    >
      <div className='px-4 pt-3.5 pb-1.5'>
        {meta && <p className='mb-1 text-xs text-muted-foreground'>{meta}</p>}
        {title && (
          <span className='mb-1.5 inline-flex h-5 items-center rounded-md bg-muted px-1.5 text-[11px] text-muted-foreground'>
            {title}
          </span>
        )}
        {question && (
          <p className='max-h-36 overflow-y-auto text-[14px] leading-6 font-medium wrap-anywhere whitespace-pre-wrap'>
            {question}
          </p>
        )}
        {body}
      </div>
      <div className='px-2 pb-2'>
        {options.map((o, i) => (
          <button
            key={o.key}
            type='button'
            disabled={busy}
            onClick={() => onPick(o.key)}
            className={cn(
              'group flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-start transition-colors hover:bg-accent disabled:opacity-60',
              picked === o.key && 'bg-accent'
            )}
          >
            <Key n={i + 1} busy={picked === o.key} />
            <span className='min-w-0 flex-1'>
              <span className='flex flex-wrap items-center gap-x-2 text-[14px] leading-6'>
                {o.label}
                {o.recommended && (
                  <span className='rounded bg-brand/15 px-1.5 text-[11px] leading-4 text-brand'>
                    {tr('推荐')}
                  </span>
                )}
              </span>
              {o.description && (
                <span className='block text-[13px] leading-5 text-muted-foreground'>
                  {o.description}
                </span>
              )}
            </span>
          </button>
        ))}
        {freeText !== undefined && onFreeText && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (note.trim()) onFreeText(note.trim())
            }}
            className='group flex items-center gap-3 rounded-xl px-2.5 py-1.5 focus-within:bg-accent/60'
          >
            <Key n={options.length + 1} />
            <input
              ref={input}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              placeholder={freeText}
              className='h-7 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground'
            />
            <button
              type='submit'
              aria-label={tr('发出')}
              disabled={!note.trim() || busy}
              className='grid size-6 shrink-0 place-items-center rounded-full bg-foreground text-background disabled:opacity-20'
            >
              {picked === FREE_KEY ? (
                <LoaderCircle className='size-3.5 animate-spin' />
              ) : (
                <ArrowUp className='size-3.5' />
              )}
            </button>
          </form>
        )}
      </div>
      {footer && (
        <div className='border-t px-4 py-1.5 text-[11px] text-muted-foreground'>
          {footer}
        </div>
      )}
    </div>
  )
}

function Key({ n, busy }: { n: number; busy?: boolean }) {
  return (
    <kbd className='mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border font-mono text-[11px] text-muted-foreground group-hover:border-foreground/30 group-hover:text-foreground'>
      {busy ? <LoaderCircle className='size-3 animate-spin' /> : n}
    </kbd>
  )
}
