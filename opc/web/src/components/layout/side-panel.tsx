import { useEffect } from 'react'
import { useLocation, useSearch } from '@tanstack/react-router'
import { PanelRightClose } from 'lucide-react'
import { useWorkspace, type SideTab } from '@/stores/workspace'
import { useBrowser } from '@/lib/desktop'
import { useOverview } from '@/lib/opc-api'
import { useOrcaTerminals } from '@/lib/orca-live'
import { cn } from '@/lib/utils'
import { AgentBrowser } from '@/features/browser/agent-browser'
import { FileTree } from '@/features/files/file-tree'

const TABS: { value: SideTab; label: string }[] = [
  { value: 'files', label: '文件' },
  { value: 'browser', label: '浏览器' },
]

/**
 * 右栏看什么：正在看的业务 / 项目的目录；集团页面上点开了 Agent 时，是那个 Agent 所在的目录。
 * 都没有（集团页面、没点开 Agent）时 root 为空，右栏不出现。
 */
export function useSideScope() {
  const pathname = useLocation({ select: (l) => l.pathname })
  const search: { project?: string } = useSearch({ strict: false })
  const agent = useWorkspace((s) => s.agent)
  const { data } = useOverview()
  const { data: terminals } = useOrcaTerminals()
  const businessId = pathname.startsWith('/b/')
    ? decodeURIComponent(pathname.slice(3))
    : null
  const business = data?.businesses.find((b) => b.id === businessId)
  const project = business?.projects?.find((p) => p.id === search.project)
  if (business) {
    return {
      agent,
      root: project?.path ?? business.workspacePath,
      label: project ? `${business.name} / ${project.name}` : business.name,
    }
  }
  const dir = terminals?.find((t) => t.handle === agent)?.project
  return {
    agent,
    root: dir ?? null,
    label: dir?.split(/[\\/]/).pop() ?? '',
  }
}

/**
 * 右栏：跟着中间栏走。
 * - 文件：看业务主页时是业务目录，看项目主页时是项目目录。
 * - 浏览器：中间栏点开的那个 Agent 开的网页。点开的 Agent 一打开网页就自动切过来（右栏收着也会打开）。
 * 集团页面没东西可看时不出现；左边缘拖动改宽度；顶栏右边的按钮开关。
 */
export function SidePanel() {
  const open = useWorkspace((s) => s.sideOpen)
  const setOpen = useWorkspace((s) => s.setSideOpen)
  const tab = useWorkspace((s) => s.sideTab)
  const setTab = useWorkspace((s) => s.setSideTab)
  const width = useWorkspace((s) => s.sideWidth)
  const { agent, root, label } = useSideScope()

  const browser = useBrowser()
  const browsing = !!agent && browser.tabs.some((t) => t.by === agent)
  useEffect(() => {
    if (browsing) {
      setTab('browser')
      setOpen(true)
    }
  }, [browsing, agent, setTab, setOpen])
  // 不看 Agent 了，浏览器没东西可看，回到文件
  useEffect(() => {
    if (!agent) {
      setTab('files')
    }
  }, [agent, setTab])

  if (!open || (!root && !agent)) {
    return null
  }
  return (
    <aside
      style={{ width }}
      className='relative flex shrink-0 flex-col border-s bg-background'
    >
      <ResizeHandle />
      <header className='flex h-10 shrink-0 items-center gap-1 border-b px-2'>
        {TABS.map((t) => (
          <button
            key={t.value}
            type='button'
            onClick={() => setTab(t.value)}
            className={cn(
              'h-7 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
              tab === t.value && 'bg-accent text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
        <button
          type='button'
          title='收起右栏'
          aria-label='收起右栏'
          onClick={() => setOpen(false)}
          className='ms-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
        >
          <PanelRightClose className='size-4' />
        </button>
      </header>
      {tab === 'browser' ? (
        <AgentBrowser handle={agent} />
      ) : root ? (
        <FileTree key={root} root={root} label={label} />
      ) : (
        <p className='px-6 py-10 text-center text-xs leading-5 text-muted-foreground'>
          这个 Agent 不在哪个目录里。
        </p>
      )}
    </aside>
  )
}

/** 左边缘：按住拖动改宽度 */
function ResizeHandle() {
  const setWidth = useWorkspace((s) => s.setSideWidth)
  return (
    <div
      role='separator'
      aria-orientation='vertical'
      aria-label='拖动改右栏宽度'
      onPointerDown={(e) => {
        e.preventDefault()
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        const right = el.parentElement!.getBoundingClientRect().right
        const move = (ev: PointerEvent) => setWidth(right - ev.clientX)
        const up = () => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
      }}
      className='absolute inset-y-0 -start-1 z-10 w-2 cursor-col-resize hover:bg-ring/30'
    />
  )
}
