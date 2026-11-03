import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, RotateCw, X } from 'lucide-react'
import {
  useBrowser,
  useBrowserViewport,
  useRemoteScreenshot,
  type BrowserControl,
  type BrowserTab,
} from '@/lib/desktop'
import { cn } from '@/lib/utils'

/**
 * 右栏「浏览器」：中间栏点开的那个 Agent 正在用的网页。
 * 每个 Agent 只看到自己开的标签页，多开互不干扰；真浏览器叠在这块上面，看着它点，也能自己接手。
 */
export function AgentBrowser({ handle }: { handle: string | null }) {
  const browser = useBrowser()
  const pages = browser.tabs.filter((t) => handle && t.by === handle)
  if (!handle) {
    return <Hint>点开一个 Agent，这里显示它在用的浏览器。</Hint>
  }
  if (!browser.control) {
    return (
      <Hint>
        {browser.remote
          ? '那台电脑上跑的不是 HiveWard 桌面 App，没有浏览器。'
          : '浏览器只在 HiveWard 桌面 App 里可用。'}
      </Hint>
    )
  }
  if (pages.length === 0) {
    return <Hint>这个 Agent 还没打开网页。</Hint>
  }
  return (
    <Pages
      key={handle}
      tabs={pages}
      control={browser.control}
      remote={browser.remote}
    />
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className='flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs leading-5 text-muted-foreground'>
      <Globe className='size-5' />
      <p>{children}</p>
    </div>
  )
}

function Pages({
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
  // 把这个 Agent 的页面设成正在显示的那一页（别的电脑上的看截图，不用切）
  useEffect(() => {
    if (!remote && !tab.active) {
      void control.activate(tab.id)
    }
  }, [tab, remote, control])
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      {tabs.length > 1 && (
        <div className='flex shrink-0 gap-1 overflow-x-auto px-2 pt-2'>
          {tabs.map((t) => (
            <div
              key={t.id}
              className={cn(
                'group flex h-7 max-w-40 min-w-0 shrink-0 items-center rounded-md text-xs text-muted-foreground hover:bg-accent',
                t.id === tab.id && 'bg-accent text-foreground'
              )}
            >
              <button
                type='button'
                title={t.url}
                onClick={() => setPicked(t.id)}
                className='flex min-w-0 items-center gap-1.5 ps-2'
              >
                {t.loading && (
                  <span className='size-1.5 shrink-0 animate-pulse rounded-full bg-live' />
                )}
                <span className='truncate'>
                  {t.title || hostOf(t.url) || '新标签页'}
                </span>
              </button>
              <button
                type='button'
                aria-label='关闭标签页'
                onClick={() => void control.close(t.id)}
                className='grid size-6 shrink-0 place-items-center rounded opacity-0 group-hover:opacity-100 hover:text-foreground'
              >
                <X className='size-3' />
              </button>
            </div>
          ))}
        </div>
      )}
      <Toolbar key={tab.id} tab={tab} control={control} />
      {remote ? <RemoteViewport tab={tab} /> : <Viewport />}
    </div>
  )
}

/** 浏览器显示区：真浏览器叠在这块上面 */
function Viewport() {
  const ref = useBrowserViewport(true)
  return <div ref={ref} className='min-h-0 flex-1 bg-white' />
}

/** 别的电脑上的页面：真浏览器在那台电脑屏幕上，这里看实时截图 */
function RemoteViewport({ tab }: { tab: BrowserTab }) {
  const src = useRemoteScreenshot(tab.id)
  return (
    <div className='relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-muted/40'>
      {src ? (
        <img src={src} alt={tab.title} className='w-full object-contain' />
      ) : (
        <p className='m-auto text-xs text-muted-foreground'>读取画面…</p>
      )}
      <span className='absolute end-3 bottom-3 rounded-md bg-background/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur'>
        在那台电脑上 · 每秒刷新的画面
      </span>
    </div>
  )
}

function Toolbar({
  tab,
  control: b,
}: {
  tab: BrowserTab
  control: BrowserControl
}) {
  // 正在编辑地址栏时用草稿，不被页面跳转覆盖；不编辑时显示真实地址
  const [draft, setDraft] = useState<string | null>(null)
  const url = draft ?? tab.url
  return (
    <header className='flex h-11 shrink-0 items-center gap-0.5 px-2'>
      <ToolButton
        label='后退'
        disabled={!tab.canGoBack}
        onClick={() => b.history(tab.id, 'back')}
      >
        <ArrowLeft />
      </ToolButton>
      <ToolButton
        label='前进'
        disabled={!tab.canGoForward}
        onClick={() => b.history(tab.id, 'forward')}
      >
        <ArrowRight />
      </ToolButton>
      <ToolButton label='刷新' onClick={() => b.history(tab.id, 'reload')}>
        <RotateCw className={cn(tab.loading && 'animate-spin')} />
      </ToolButton>
      <form
        className='ms-1 min-w-0 flex-1'
        onSubmit={(e) => {
          e.preventDefault()
          void b.navigate(tab.id, url)
          setDraft(null)
          ;(document.activeElement as HTMLElement | null)?.blur()
        }}
      >
        <input
          value={url}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => {
            setDraft(tab.url)
            e.target.select()
          }}
          onBlur={() => setDraft(null)}
          spellCheck={false}
          className='h-7 w-full rounded-md bg-muted px-2.5 font-mono text-[11px] outline-none focus:ring-1 focus:ring-ring'
        />
      </form>
    </header>
  )
}

function ToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className='flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent [&_svg]:size-3.5'
    >
      {children}
    </button>
  )
}

function hostOf(url: string) {
  try {
    const u = new URL(url)
    return u.protocol.startsWith('http') ? u.host : ''
  } catch {
    return ''
  }
}
