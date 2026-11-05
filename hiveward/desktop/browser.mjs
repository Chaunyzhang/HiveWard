// HiveWard 内嵌的真浏览器：每个标签页是一个独立的 WebContentsView，叠在 HiveWard 窗口里网页留出的那块区域上。
// 登录按「档案」隔离：同一个档案（通常是业务 id）共用一份持久化的 cookie / 存储。
import { WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'

const partitionOf = (profile) => `persist:hiveward-${profile.replace(/[^\w-]/g, '_')}`

export class BrowserTabs {
  /** @param {import('electron').BrowserWindow} win */
  constructor(
    win,
    {
      isBlockedUrl = () => false,
      installSessionUserAgent,
      acquireDebugger,
      createPopupHandler,
      partitionForProfile = partitionOf
    } = {}
  ) {
    this.partitionForProfile = partitionForProfile
    this.isBlockedUrl = isBlockedUrl
    this.installSessionUserAgent = installSessionUserAgent
    this.acquireDebugger = acquireDebugger
    this.createPopupHandler = createPopupHandler
    this.configuredSessions = new WeakSet()
    this.win = win
    /** @type {Map<string, {id: string, view: WebContentsView, profile: string, by?: string, openedAt: string}>} */
    this.tabs = new Map()
    this.active = null
    this.bounds = null
    this.listeners = new Set()
    this.installSession(win.webContents.session)
  }

  // 每个档案的 session 只装一次；弹窗和同档案标签自然共用这套引擎规则。
  installSession(session) {
    if (this.configuredSessions.has(session)) {
      return
    }
    this.installSessionUserAgent(session)
    session.webRequest.onBeforeRequest((details, done) =>
      done({ cancel: this.isBlockedUrl(details.url) })
    )
    this.configuredSessions.add(session)
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit() {
    const list = this.list()
    for (const fn of this.listeners) {
      fn(list)
    }
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
      openedAt: t.openedAt
    }
  }

  list() {
    return [...this.tabs.values()].map((t) => this.info(t))
  }

  get(id) {
    const t = this.tabs.get(id)
    if (!t) {
      throw Object.assign(new Error(`没有这个标签页：${id}`), { status: 404, code: 'not_found' })
    }
    return t
  }

  /** 新开标签页。profile 决定用哪份登录；by 记下是谁开的（Agent 的终端 handle） */
  open({ url = 'about:blank', profile = 'default', by, activate = true } = {}) {
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partitionForProfile(profile),
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false
      }
    })
    this.installSession(view.webContents.session)
    view.setVisible(false)
    view.setBackgroundColor('#ffffff')
    const t = {
      id: randomUUID().slice(0, 8),
      view,
      profile,
      by,
      openedAt: new Date().toISOString()
    }
    this.tabs.set(t.id, t)
    const wc = view.webContents
    for (const e of [
      'did-start-loading',
      'did-stop-loading',
      'page-title-updated',
      'did-navigate',
      'did-navigate-in-page'
    ]) {
      wc.on(e, () => this.emit())
    }
    // 普通链接开 HiveWard 标签；依赖 opener 的登录弹窗保留原生父子窗口。
    wc.setWindowOpenHandler(
      this.createPopupHandler(wc, {
        isActive: () => this.active === t.id,
        openTab: (url, activate) => {
          this.open({ url, profile, by, activate })
        },
        prepareSession: (session) => this.installSession(session)
      })
    )
    wc.loadURL(normalizeUrl(url)).catch(() => {})
    if (activate) {
      this.activate(t.id)
    } else {
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
    const wasActive = this.active === id
    if (!this.win.isDestroyed()) {
      this.win.contentView.removeChildView(t.view)
    }
    if (this.active === id) {
      this.active = null
    }
    this.tabs.delete(id)
    if (!t.view.webContents.isDestroyed()) {
      t.view.webContents.close()
    }
    if (wasActive) {
      const first = this.tabs.keys().next().value
      if (first) {
        return (this.activate(first), { closed: id })
      }
    }
    this.place()
    this.emit()
    return { closed: id }
  }

  destroy() {
    const all = [...this.tabs.values()]
    this.tabs.clear()
    this.active = null
    this.listeners.clear()
    for (const t of all) {
      if (!this.win.isDestroyed()) {
        this.win.contentView.removeChildView(t.view)
      }
      if (!t.view.webContents.isDestroyed()) {
        t.view.webContents.close()
      }
    }
  }

  navigate(id, url) {
    this.get(id)
      .view.webContents.loadURL(normalizeUrl(url))
      .catch(() => {})
    return { ok: true }
  }

  history(id, action) {
    const wc = this.get(id).view.webContents
    if (action === 'back' && wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack()
    }
    if (action === 'forward' && wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward()
    }
    if (action === 'reload') {
      wc.reload()
    }
    return { ok: true }
  }

  /** 网页报告它留给浏览器的那块区域（CSS 像素，相对窗口内容区）；null 表示现在不显示 */
  setBounds(rect) {
    const valid =
      rect &&
      ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) &&
      rect.x >= 0 &&
      rect.y >= 0 &&
      rect.width > 0 &&
      rect.height > 0
    this.bounds = valid ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
    this.place()
  }

  // 可见性完全由「当前标签 + 网页刚报的有效面板矩形」派生；隐藏标签保持挂载，供 Agent 后台操作。
  place() {
    const root = this.win.contentView
    const top = this.active && this.bounds ? this.tabs.get(this.active) : null
    for (const t of this.tabs.values()) {
      if (!root.children.includes(t.view)) {
        root.addChildView(t.view)
      }
      if (t !== top) {
        t.view.setVisible(false)
      }
    }
    if (!top) {
      return
    }
    const { x, y, width, height } = this.bounds
    top.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    })
    if (root.children.at(-1) !== top.view) {
      root.addChildView(top.view)
    }
    top.view.setVisible(true)
  }

  // 截图：优先直接取；隐藏且从没出过帧的页面用调试协议现画一张，不把它显示到窗口上。
  async screenshot(id) {
    const wc = this.get(id).view.webContents
    const capture = () =>
      withTimeout(wc.capturePage(), 3000)
        .then((img) => (img.isEmpty() ? null : img.toPNG()))
        .catch(() => null)
    const first = await capture()
    if (first) {
      return first
    }
    // 从没在屏幕上画过的页面：capturePage 回空图，调试协议截图也一直等不到画面；
    // 但挂上调试器、发过截图命令之后页面就开始出帧了，这时再 capturePage 一次就有了
    const shot = await this.withDebugger(wc, () =>
      withTimeout(cdp(wc, 'Page.captureScreenshot', { format: 'png' }), 1500)
    ).catch(() => null)
    if (shot) {
      return Buffer.from(shot.data, 'base64')
    }
    const again = await capture()
    if (again) {
      return again
    }
    throw Object.assign(new Error('截图超时'), { status: 504, code: 'timeout' })
  }

  webContents(id) {
    return this.get(id).view.webContents
  }

  async withDebugger(wc, operation) {
    const lease = this.acquireDebugger(wc)
    try {
      return await operation()
    } finally {
      lease.release()
    }
  }
}

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error('截图超时'), { status: 504, code: 'timeout' })),
        ms
      )
    })
  ]).finally(() => clearTimeout(timer))
}

/** 调用方持有 debugger lease，只在这里发命令，不把调试器留在页面上。 */
export async function cdp(wc, method, params = {}) {
  return wc.debugger.sendCommand(method, params)
}

function normalizeUrl(url) {
  const u = String(url).trim()
  if (!u) {
    return 'about:blank'
  }
  if (/^(https?|about|file|data):/i.test(u)) {
    return u
  }
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(u)) {
    return `https://${u}`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(u)}`
}
