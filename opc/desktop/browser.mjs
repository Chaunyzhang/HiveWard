// OPC 内嵌的真浏览器：每个标签页是一个独立的 WebContentsView，叠在 OPC 窗口里网页留出的那块区域上。
// 登录按「档案」隔离：同一个档案（通常是业务 id）共用一份持久化的 cookie / 存储。
import { WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'

const partitionOf = (profile) => `persist:opc-${profile.replace(/[^\w-]/g, '_')}`

export class BrowserTabs {
  /** @param {import('electron').BrowserWindow} win */
  constructor(win, { isBlockedUrl = () => false } = {}) {
    this.isBlockedUrl = isBlockedUrl
    this.win = win
    /** @type {Map<string, {id: string, view: WebContentsView, profile: string, by?: string, openedAt: string}>} */
    this.tabs = new Map()
    this.active = null
    this.bounds = null
    this.listeners = new Set()
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit() {
    const list = this.list()
    for (const fn of this.listeners) {fn(list)}
  }

  info(t) {
    const wc = t.view.webContents
    return {
      id: t.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      profile: t.profile,
      by: t.by,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      active: t.id === this.active,
      openedAt: t.openedAt,
    }
  }

  list() {
    return [...this.tabs.values()].map((t) => this.info(t))
  }

  get(id) {
    const t = this.tabs.get(id)
    if (!t) {throw Object.assign(new Error(`没有这个标签页：${id}`), { status: 404, code: 'not_found' })}
    return t
  }

  /** 新开标签页。profile 决定用哪份登录；by 记下是谁开的（Agent 的终端 handle） */
  open({ url = 'about:blank', profile = 'default', by, activate = true } = {}) {
    const view = new WebContentsView({
      webPreferences: { partition: partitionOf(profile), sandbox: true, contextIsolation: true, backgroundThrottling: false },
    })
    view.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: this.isBlockedUrl(details.url) }))
    view.setBackgroundColor('#ffffff')
    const t = { id: randomUUID().slice(0, 8), view, profile, by, openedAt: new Date().toISOString() }
    this.tabs.set(t.id, t)
    const wc = view.webContents
    for (const e of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page'])
      {wc.on(e, () => this.emit())}
    // 网页里的 target=_blank / window.open：在 OPC 里开新标签，沿用同一份登录
    wc.setWindowOpenHandler(({ url: next }) => {
      this.open({ url: next, profile, by })
      return { action: 'deny' }
    })
    wc.loadURL(normalizeUrl(url)).catch(() => {})
    if (activate || !this.active) {this.activate(t.id)}
    else {
      this.place()
      this.emit()
    }
    return this.info(t)
  }

  activate(id) {
    const next = this.get(id)
    this.active = id
    this.place()
    this.emit()
    return this.info(next)
  }

  close(id) {
    const t = this.get(id)
    if (!this.win.isDestroyed()) {this.win.contentView.removeChildView(t.view)}
    if (this.active === id) {this.active = null}
    this.tabs.delete(id)
    if (!t.view.webContents.isDestroyed()) {t.view.webContents.close()}
    if (!this.active) {
      const first = this.tabs.keys().next().value
      if (first) {return this.activate(first), { closed: id }}
    }
    this.emit()
    return { closed: id }
  }

  destroy() {
    const all = [...this.tabs.values()]
    this.tabs.clear()
    this.active = null
    this.listeners.clear()
    for (const t of all) {
      if (!this.win.isDestroyed()) {this.win.contentView.removeChildView(t.view)}
      if (!t.view.webContents.isDestroyed()) {t.view.webContents.close()}
    }
  }

  navigate(id, url) {
    this.get(id).view.webContents.loadURL(normalizeUrl(url)).catch(() => {})
    return { ok: true }
  }

  history(id, action) {
    const wc = this.get(id).view.webContents
    if (action === 'back' && wc.navigationHistory.canGoBack()) {wc.navigationHistory.goBack()}
    if (action === 'forward' && wc.navigationHistory.canGoForward()) {wc.navigationHistory.goForward()}
    if (action === 'reload') {wc.reload()}
    return { ok: true }
  }

  /** 网页报告它留给浏览器的那块区域（CSS 像素，相对窗口内容区）；null 表示现在不显示 */
  setBounds(rect) {
    this.bounds = rect && rect.width > 0 && rect.height > 0 ? rect : null
    this.place()
  }

  /**
   * 摆放所有标签页。正在看的那个放进驾驶舱网页留出的区域；其余的（包括驾驶舱暂时不显示浏览器时的全部）
   * 挪到窗口外面：用户看不见，但仍然挂在窗口上照常渲染，Agent 在后台操作、截图都不受影响。
   */
  place() {
    const root = this.win.contentView
    const size = this.bounds ?? { width: 1280, height: 800 }
    for (const t of this.tabs.values()) {
      const shown = t.id === this.active && this.bounds
      const { x, y } = shown ? this.bounds : { x: -size.width - 200, y: 0 }
      t.view.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(size.width), height: Math.round(size.height) })
      if (!root.children.includes(t.view)) {root.addChildView(t.view)}
    }
    // 正在看的放到最上层
    const top = this.active && this.bounds && this.tabs.get(this.active)
    if (top && root.children.at(-1) !== top.view) {root.addChildView(top.view)}
  }

  // 截图：屏幕上画过的直接取；挪在窗口外、从没显示过的页面没有现成画面，用调试协议让它现画一张
  async screenshot(id) {
    const wc = this.get(id).view.webContents
    const capture = () => withTimeout(wc.capturePage(), 3000).then((img) => (img.isEmpty() ? null : img.toPNG())).catch(() => null)
    const first = await capture()
    if (first) {return first}
    // 从没在屏幕上画过的页面：capturePage 回空图，调试协议截图也一直等不到画面；
    // 但挂上调试器、发过截图命令之后页面就开始出帧了，这时再 capturePage 一次就有了
    const shot = await withTimeout(cdp(wc, 'Page.captureScreenshot', { format: 'png' }), 1500).catch(() => null)
    if (shot) {return Buffer.from(shot.data, 'base64')}
    const again = await capture()
    if (again) {return again}
    throw Object.assign(new Error('截图超时'), { status: 504, code: 'timeout' })
  }

  webContents(id) {
    return this.get(id).view.webContents
  }
}

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('截图超时'), { status: 504, code: 'timeout' })), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/** 对某个标签页发调试协议命令；调试器每个页面只挂一次，截图和 Agent 操作共用 */
export async function cdp(wc, method, params = {}) {
  if (!wc.debugger.isAttached()) {wc.debugger.attach('1.3')}
  return wc.debugger.sendCommand(method, params)
}

function normalizeUrl(url) {
  const u = String(url).trim()
  if (!u) {return 'about:blank'}
  if (/^(https?|about|file|data):/i.test(u)) {return u}
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(u)) {return `https://${u}`}
  return `https://www.google.com/search?q=${encodeURIComponent(u)}`
}
