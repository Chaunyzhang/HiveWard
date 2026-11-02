import { useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react'
import {
  useBrowser,
  useBrowserViewport,
  useRemoteScreenshot,
  type BrowserControl,
  type BrowserTab,
} from '@/lib/desktop'
import { useOverview } from '@/lib/opc-api'
import { useOrcaTerminals } from '@/lib/orca-live'
import { cn } from '@/lib/utils'
import { AgentName } from '@/components/opc/agent-logo'

/**
 * 浏览器：OPC 里的真浏览器。每个业务一份登录（档案），老板和 Agent 用的是同一批标签页——
 * Agent 在操作的页面这里直接看得见，也能随时接手点。
 */
export function Browser() {
  const browser = useBrowser()
  if (!browser.control) {
    return (
      <div className='flex h-[calc(100svh-3rem)] flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground'>
        <Globe className='size-6' />
        {browser.remote ? (
          <p>那台电脑上跑的不是 HiveWard 桌面 App，没有浏览器。</p>
        ) : (
          <>
            <p>浏览器只在 HiveWard 桌面 App 里可用。</p>
          </>
        )}
      </div>
    )
  }
  return (
    <BrowserWorkspace
      tabs={browser.tabs}
      control={browser.control}
      remote={browser.remote}
    />
  )
}

function BrowserWorkspace({
  tabs,
  control,
  remote,
}: {
  tabs: BrowserTab[]
  control: BrowserControl
  remote: boolean
}) {
  const current = tabs.find((t) => t.active) ?? null
  return (
    <div className='grid h-[calc(100svh-3rem)] grid-cols-[260px_minmax(0,1fr)] gap-5 p-5'>
      <section className='flex min-h-0 flex-col overflow-hidden rounded-xl panel'>
        <header className='flex h-12 shrink-0 items-center gap-2 px-4'>
          <h2 className='text-[13px] font-medium'>标签页</h2>
          <span className='text-xs text-muted-foreground'>
            {tabs.length || ''}
          </span>
          <NewTab control={control} />
        </header>
        <div className='min-h-0 flex-1 overflow-y-auto px-2 pb-3'>
          <TabList tabs={tabs} control={control} />
        </div>
      </section>

      <section className='flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl panel'>
        {current ? (
          <>
            <Toolbar key={current.id} tab={current} control={control} />
            {remote ? <RemoteViewport tab={current} /> : <Viewport />}
          </>
        ) : (
          <div className='flex flex-1 items-center justify-center text-[13px] text-muted-foreground'>
            还没有标签页，点左上角 + 打开一个网站
          </div>
        )}
      </section>
    </div>
  )
}

/** 浏览器显示区：真浏览器叠在这块上面 */
function Viewport() {
  const ref = useBrowserViewport(true)
  return <div ref={ref} className='min-h-0 flex-1 bg-white' />
}

/** 别的电脑上的页面：真浏览器在那台电脑屏幕上，这里看实时截图 */
export function RemoteViewport({ tab }: { tab: BrowserTab }) {
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
    <header className='flex h-12 shrink-0 items-center gap-1 px-3'>
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
        className='mx-1 flex-1'
        onSubmit={(e) => {
          e.preventDefault()
          b.navigate(tab.id, url)
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
          className='h-8 w-full rounded-md bg-muted px-3 font-mono text-xs outline-none focus:ring-1 focus:ring-ring'
        />
      </form>
      <ProfileBadge profile={tab.profile} />
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
      className='flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent [&_svg]:size-4'
    >
      {children}
    </button>
  )
}

function useProfileName() {
  const { data } = useOverview()
  return (profile: string) => {
    const b = data?.businesses.find((x) => x.id === profile)
    return b ? b.name : profile === 'default' ? '默认' : profile
  }
}

function ProfileBadge({ profile }: { profile: string }) {
  const name = useProfileName()
  return (
    <span
      title='登录档案：同一档案的标签页共用登录'
      className='shrink-0 rounded-md px-2 text-xs text-muted-foreground'
    >
      {name(profile)}
    </span>
  )
}

function TabList({
  tabs,
  control,
}: {
  tabs: BrowserTab[]
  control: BrowserControl
}) {
  const name = useProfileName()
  const terminals = useOrcaTerminals()
  const agentOf = (by?: string) => {
    const t = by ? terminals.data?.find((x) => x.handle === by) : undefined
    return t ? (t.agent ?? 'Agent') : by ? 'Agent' : null
  }
  const groups = new Map<string, BrowserTab[]>()
  for (const t of tabs)
    groups.set(t.profile, [...(groups.get(t.profile) ?? []), t])

  return (
    <div className='space-y-4'>
      {[...groups].map(([profile, items]) => (
        <div key={profile}>
          <h3 className='mb-0.5 px-2 text-xs text-muted-foreground'>
            {name(profile)}
          </h3>
          <ul className='space-y-0.5'>
            {items.map((t) => {
              const agent = agentOf(t.by)
              return (
                <li key={t.id} className='group relative'>
                  <button
                    type='button'
                    data-open={t.active}
                    onClick={() => control.activate(t.id)}
                    className='block w-full rounded-md hover-box px-2 py-1.5 pe-7 text-start'
                  >
                    <span className='flex items-center gap-2'>
                      <span
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          t.loading
                            ? 'animate-pulse bg-live'
                            : 'bg-muted-foreground/40'
                        )}
                      />
                      <span className='truncate text-[13px]'>
                        {t.title || hostOf(t.url) || '新标签页'}
                      </span>
                    </span>
                    <span className='mt-0.5 flex gap-2 ps-3.5 text-[11px] text-muted-foreground'>
                      <span className='truncate font-mono'>
                        {hostOf(t.url)}
                      </span>
                      {agent && (
                        <span className='ms-auto inline-flex shrink-0 items-center gap-1'>
                          <AgentName agent={agent} /> 在用
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type='button'
                    aria-label='关闭标签页'
                    onClick={() => control.close(t.id)}
                    className='absolute end-1 top-1.5 hidden size-6 items-center justify-center rounded-md text-muted-foreground group-hover:flex hover:bg-background hover:text-foreground'
                  >
                    <X className='size-3.5' />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

function NewTab({ control }: { control: BrowserControl }) {
  const { data } = useOverview()
  const [profile, setProfile] = useState('default')
  const businesses = (data?.businesses ?? []).filter(
    (b) => b.status !== 'archived'
  )
  return (
    <div className='ms-auto flex items-center gap-1'>
      <select
        value={profile}
        onChange={(e) => setProfile(e.target.value)}
        title='用哪份登录打开'
        className='h-7 max-w-24 rounded-md bg-transparent px-1 text-xs text-muted-foreground hover:bg-accent'
      >
        <option value='default'>默认</option>
        {businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <button
        type='button'
        aria-label='新标签页'
        onClick={() => control.open({ url: 'about:blank', profile })}
        className='flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
      >
        <Plus className='size-4' />
      </button>
    </div>
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
