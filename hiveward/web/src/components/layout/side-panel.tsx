import { useEffect } from 'react'
import { useLocation, useSearch } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { useWorkspace, type SideTab } from '@/stores/workspace'
import { useBrowser } from '@/lib/desktop'
import { useOverview } from '@/lib/hiveward-api'
import { useHiveWardTerminals } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { MachineScope } from '@/lib/machine'
import { AgentBrowser } from '@/features/browser/agent-browser'
import { useFileOpen } from '@/features/files/file-open'
import { FileTree } from '@/features/files/file-tree'
import { ChangesPanel } from '@/features/session/changes-panel'
import {
  BackgroundTasksPanel,
  PlanPanel,
  SideChatPanel,
} from '@/features/session/session-panels'

const TITLES: Record<SideTab, string> = {
  changes: tr('更改'),
  browser: tr('浏览器'),
  files: tr('文件'),
  tasks: tr('后台任务'),
  plan: tr('计划'),
  chat: tr('侧边对话'),
}

/**
 * 右栏看什么：中间栏打开了会话时，是这个会话的工作目录；否则是正在看的业务 / 项目的目录；
 * 「现场」里点开终端时是那个终端所在的目录。都没有（集团页面）时是 Agent 最近打开给老板看的文件所在目录，
 * 再没有 root 为空。
 */
export function useSideScope() {
  const pathname = useLocation({ select: (l) => l.pathname })
  const search: { project?: string } = useSearch({ strict: false })
  const agent = useWorkspace((s) => s.agent)
  const session = useWorkspace((s) => s.session)
  const { data } = useOverview()
  const { data: terminals } = useHiveWardTerminals()
  const fallback = useFileOpen((s) => s.fallbackRoot)
  const basename = (dir: string) => dir.split(/[\\/]/).pop() ?? dir
  if (session) {
    return {
      agent,
      session,
      root: session.dir ?? null,
      label: session.dir ? basename(session.dir) : '',
    }
  }
  const businessId = pathname.startsWith('/b/')
    ? decodeURIComponent(pathname.slice(3))
    : null
  const business = data?.businesses.find((b) => b.id === businessId)
  const project = business?.projects?.find((p) => p.id === search.project)
  if (business) {
    return {
      agent,
      session,
      root: project?.path ?? business.workspacePath,
      label: project ? `${business.name} / ${project.name}` : business.name,
    }
  }
  const dir = terminals?.find((t) => t.handle === agent)?.project ?? fallback
  return {
    agent,
    session,
    root: dir ?? null,
    label: dir ? basename(dir) : '',
  }
}

/** 这一样在眼下能不能看：浏览器随时能开，后台任务 / 计划 / 侧边对话要打开了会话，更改 / 文件要有目录 */
function available(
  tab: SideTab,
  scope: ReturnType<typeof useSideScope>
): boolean {
  switch (tab) {
    case 'browser':
      return true
    case 'tasks':
    case 'chat':
      return !!scope.session
    case 'plan':
      return !!scope.session?.handle
    case 'changes':
    case 'files':
      return !!scope.root
  }
}

/**
 * 右栏：一次看一样（更改 / 浏览器 / 文件 / 后台任务 / 计划 / 侧边对话），由对话上方的工具栏开关；
 * 再点同一个按钮收起。点开的 Agent 一打开网页就自动切到浏览器。左边缘拖动改宽度。
 */
export function SidePanel() {
  const open = useWorkspace((s) => s.sideOpen)
  const setOpen = useWorkspace((s) => s.setSideOpen)
  const tab = useWorkspace((s) => s.sideTab)
  const setTab = useWorkspace((s) => s.setSideTab)
  const width = useWorkspace((s) => s.sideWidth)
  const scope = useSideScope()
  const { agent, root, label, session } = scope

  const browser = useBrowser()
  const browsing = !!agent && browser.tabs.some((t) => t.by === agent)
  useEffect(() => {
    if (browsing) {
      setTab('browser')
      setOpen(true)
    }
  }, [browsing, agent, setTab, setOpen])

  if (!open || !available(tab, scope)) {
    return null
  }
  const body =
    tab === 'browser' ? (
      <AgentBrowser handle={agent} />
    ) : tab === 'changes' ? (
      <ChangesPanel key={root} dir={root!} />
    ) : tab === 'tasks' ? (
      <BackgroundTasksPanel />
    ) : tab === 'plan' ? (
      <PlanPanel key={session!.handle} handle={session!.handle!} />
    ) : tab === 'chat' ? (
      <SideChatPanel />
    ) : (
      <FileTree key={root} root={root!} label={label} />
    )
  return (
    <aside
      style={{ width }}
      className='relative flex max-w-[45%] shrink-0 flex-col border-s bg-background'
    >
      <ResizeHandle />
      {tab !== 'chat' && (
        <header className='app-top-bar flex h-12 shrink-0 items-center gap-2 border-b ps-4 pe-2'>
          <h2 className='text-[13px] font-medium'>{TITLES[tab]}</h2>
          {(tab === 'changes' || tab === 'files') && label && (
            <span className='min-w-0 truncate text-xs text-muted-foreground'>
              {label}
            </span>
          )}
          <button
            type='button'
            title={tr('收起右栏')}
            aria-label={tr('收起右栏')}
            onClick={() => setOpen(false)}
            className='ms-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
          >
            <X className='size-4' />
          </button>
        </header>
      )}
      {session ? (
        <MachineScope id={session.machine}>{body}</MachineScope>
      ) : (
        body
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
      aria-label={tr('拖动改右栏宽度')}
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
