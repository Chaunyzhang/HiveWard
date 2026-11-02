import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { scoped, useMachineId } from './machine'

/** 桌面 App 里内嵌浏览器的一个标签页（desktop/browser.mjs 的 info()） */
export interface BrowserTab {
  id: string
  url: string
  title: string
  /** 登录档案：通常是业务 id，同一档案共用登录 */
  profile: string
  /** 谁开的：Agent 的 Orca 终端 handle；老板自己开的为空 */
  by?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  active: boolean
  openedAt: string
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface DesktopApi {
  platform: string
  /** 系统的选目录框；取消时为 null（只有 HiveWard App 有） */
  pickFolder?: () => Promise<string | null>
  /** App 菜单、系统通知让网页切到某个站内页面（只有 HiveWard App 有） */
  onNavigate?: (fn: (path: string) => void) => () => void
  browser: {
    list: () => Promise<BrowserTab[]>
    open: (opts: {
      url?: string
      profile?: string
      activate?: boolean
    }) => Promise<BrowserTab>
    close: (id: string) => Promise<unknown>
    activate: (id: string) => Promise<BrowserTab>
    navigate: (id: string, url: string) => Promise<unknown>
    history: (
      id: string,
      action: 'back' | 'forward' | 'reload'
    ) => Promise<unknown>
    setBounds: (rect: Rect | null) => void
    onChange: (fn: (tabs: BrowserTab[]) => void) => () => void
  }
}

declare global {
  interface Window {
    opcDesktop?: DesktopApi
  }
}

/** 在 HiveWard 桌面 App 里才有；普通浏览器里打开驾驶舱时为 undefined */
export const desktop =
  typeof window === 'undefined' ? undefined : window.opcDesktop

/** 接 App 菜单（设置…）、系统通知点击发来的跳转；只认站内路径 */
export function useDesktopNavigation() {
  const router = useRouter()
  useEffect(
    () =>
      desktop?.onNavigate?.((path) => {
        if (path.startsWith('/') && !path.startsWith('//')) {
          router.history.push(path)
        }
      }),
    [router]
  )
}

/** 浏览器的操作：本机走桌面 App 的 IPC，别的电脑走它的 HTTP 接口（经本机转发） */
export interface BrowserControl {
  open: (opts: { url?: string; profile?: string }) => Promise<unknown>
  close: (id: string) => Promise<unknown>
  activate: (id: string) => Promise<unknown>
  navigate: (id: string, url: string) => Promise<unknown>
  history: (
    id: string,
    action: 'back' | 'forward' | 'reload'
  ) => Promise<unknown>
}

async function post(path: string, machine: string | null, body: unknown = {}) {
  const res = await fetch(scoped(path, machine), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
  return data
}

const tab = (id: string) => `/api/browser/tabs/${encodeURIComponent(id)}`

const remoteControl = (m: string | null): BrowserControl => ({
  open: (opts) => post('/api/browser/tabs', m, opts),
  close: (id) => post(`${tab(id)}/close`, m),
  activate: (id) => post(`${tab(id)}/activate`, m),
  navigate: (id, url) => post(`${tab(id)}/goto`, m, { url }),
  history: (id, action) => post(`${tab(id)}/${action}`, m),
})

/** 别的电脑上某个标签页的截图地址（经本机转发） */
export const remoteScreenshot = (id: string, machine?: string | null) =>
  scoped(`${tab(id)}/screenshot`, machine)

/** 内嵌浏览器的全部标签页，主进程一有变化就推过来 */
function useLocalTabs(enabled: boolean) {
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  useEffect(() => {
    if (!desktop || !enabled) return
    let alive = true
    desktop.browser.list().then((t) => alive && setTabs(t))
    const off = desktop.browser.onChange(setTabs)
    return () => {
      alive = false
      off()
    }
  }, [enabled])
  return tabs
}

/**
 * 正在看的那台电脑的浏览器。
 * - 本机：真浏览器叠在页面上（useBrowserViewport），control 走 IPC；不在桌面 App 里时 control 为 null。
 * - 别的电脑：真浏览器在那台电脑的屏幕上，这里只能看它的截图（remoteScreenshot），control 走转发接口。
 *   那台电脑不是桌面 App（没有浏览器接口）时 control 为 null。
 */
export function useBrowser() {
  const m = useMachineId()
  const remote = m !== null
  const localTabs = useLocalTabs(!remote)
  const remoteTabs = useQuery({
    queryKey: ['browser', 'tabs', m],
    queryFn: async () => {
      const res = await fetch(scoped('/api/browser/tabs', m))
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return ((await res.json()) as { tabs: BrowserTab[] }).tabs
    },
    enabled: remote,
    refetchInterval: 1_500,
    retry: false,
  })
  if (remote)
    return {
      remote,
      tabs: remoteTabs.data ?? [],
      control: remoteTabs.data === null ? null : remoteControl(m),
    }
  return {
    remote,
    tabs: localTabs,
    control: desktop ? (desktop.browser as BrowserControl) : null,
  }
}

/** 别的电脑上的页面：每秒换一张截图。新图加载好了再换，不闪 */
export function useRemoteScreenshot(id: string | undefined, enabled = true) {
  const m = useMachineId()
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!id || !enabled) return
    let alive = true
    let timer = 0
    const tick = () => {
      const img = new Image()
      const next = `${remoteScreenshot(id, m)}?t=${Date.now()}`
      img.onload = () => {
        if (!alive) return
        setSrc(next)
        timer = window.setTimeout(tick, 1_000)
      }
      img.onerror = () => {
        if (alive) timer = window.setTimeout(tick, 3_000)
      }
      img.src = next
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [id, enabled, m])
  return src
}

// 会盖住浏览器区域的浮层：下拉菜单、对话框、展开的侧栏。
// 真浏览器是叠在网页上面的原生视图，网页浮层画不到它上面，所以浮层出现时先把浏览器藏起来。
const OVERLAYS =
  '[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"], [role="alertdialog"], nav[data-open="true"]'

/**
 * 给真浏览器留位置：返回的 ref 挂在一个 div 上，这个 div 的位置和大小就是浏览器显示的区域。
 * 位置变化（窗口缩放、抽屉滑入动画）时跟着走；卸载或被浮层盖住时隐藏浏览器。
 */
export function useBrowserViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!desktop || !enabled || !el) return
    let last = ''
    let frame = 0
    const send = () => {
      const covered = [...document.querySelectorAll(OVERLAYS)].some(
        (o) => !o.contains(el)
      )
      const r = el.getBoundingClientRect()
      const rect = covered
        ? null
        : { x: r.left, y: r.top, width: r.width, height: r.height }
      const key = JSON.stringify(rect)
      if (key !== last) {
        last = key
        desktop!.browser.setBounds(rect)
      }
    }
    // 每帧对一次位置：抽屉动画、布局变化都能跟上；没变化就不发
    const loop = () => {
      send()
      frame = requestAnimationFrame(loop)
    }
    loop()
    return () => {
      cancelAnimationFrame(frame)
      desktop!.browser.setBounds(null)
    }
  }, [enabled])
  return ref
}
