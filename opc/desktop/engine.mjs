import { configureWindowsProcesses } from '../server/transcripts.mjs'
import { configureTerminalCli, packagedCliDirectory } from '../server/terminal-cli.mjs'
import { app, dialog, ipcMain, shell, webContents, Menu } from 'electron'
import { prepareDataDirectory } from '../server/engine-data.mjs'
import { captureWindow } from './capture-window.mjs'
import { BrowserTabs } from './browser.mjs'

export async function startCockpit({
  window,
  windowsProcesses,
  root,
  metadataPath,
  dataPath,
  staticDir,
  development,
  getMainWindow,
  isBlockedUrl,
  terminalStreaming,
  onMachineInvite,
  captureExitEnvironment,
  onExitRegionWarning,
  clipboardAdapter,
  onClipboardNotice
}) {
  if (windowsProcesses) {
    configureWindowsProcesses(windowsProcesses)
  }
  configureTerminalCli(packagedCliDirectory(root))
  await prepareDataDirectory(dataPath)
  const { browserRoutes } = await import('./browser-routes.mjs')
  const { configureRuntimeMetadata, closeRuntimeConnection } =
    await import('../server/orca-client.mjs')
  configureRuntimeMetadata(metadataPath)
  const { startBridge } = await import('../server/orca-bridge.mjs')
  // 本机端口用冷门的 47615：8787 和 Grok Bot 的 MCP 登录回调撞了
  const port = Number(process.env.OPC_PORT ?? 47615)
  const lanPort = Number(process.env.OPC_LAN_PORT ?? 8788)
  let origin
  let tabs
  let browserBounds = null
  const handlers = []
  const listeners = []
  const unavailable = () => {
    throw Object.assign(new Error('驾驶舱窗口尚未打开'), { status: 503 })
  }
  const getTabs = () => tabs ?? unavailable()
  const validRect = (rect) =>
    rect &&
    ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(rect[k])) &&
    rect.width > 0 &&
    rect.height > 0
  function placeBrowser() {
    if (!tabs) {
      return
    }
    if (!window || !browserBounds) {
      return tabs.setBounds(null)
    }
    const [width, height] = window.getContentSize()
    const bounds = { x: 0, y: 0, width, height }
    const left = Math.max(0, browserBounds.x),
      top = Math.max(0, browserBounds.y)
    tabs.setBounds({
      x: bounds.x + left,
      y: bounds.y + top,
      width: Math.max(0, Math.min(browserBounds.width, bounds.width - left)),
      height: Math.max(0, Math.min(browserBounds.height, bounds.height - top))
    })
  }
  const isCockpit = (e) =>
    window &&
    e.sender === window.webContents &&
    e.senderFrame === window.webContents.mainFrame &&
    e.senderFrame.url.startsWith(`${origin}/`)
  function listen(channel, check, fn) {
    const cb = (e, ...args) => {
      if (check(e)) {
        fn(...args)
      }
    }
    ipcMain.on(channel, cb)
    listeners.push([channel, cb])
  }
  function handle(channel, fn) {
    ipcMain.handle(channel, (e, ...args) => {
      if (!isCockpit(e)) {
        throw new Error('Untrusted cockpit IPC sender')
      }
      return fn(...args)
    })
    handlers.push(channel)
  }
  function destroyViews() {
    tabs?.destroy()
    tabs = null
    browserBounds = null
  }
  async function attach(win) {
    window = win
    window.webContents.session.webRequest.onBeforeRequest((details, done) =>
      done({ cancel: isBlockedUrl(details.url) })
    )
    window.on('resize', placeBrowser)
    tabs = new BrowserTabs(window, { isBlockedUrl })
    tabs.onChange((list) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('browser:changed', list)
      }
    })
    // 只放行「在 Grok Bot 里打开某个 Bot 的对话」这一种链接，交给系统打开 Grok Bot；其余新窗口一律拒绝
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^grokbot:\/\/app\/v1\/agent\?id=[A-Za-z0-9_-]{1,128}$/.test(url)) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) {
        event.preventDefault()
      }
    })
    window.webContents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) {
        browserBounds = null
        placeBrowser()
      }
    })
    window.once('closed', () => {
      destroyViews()
      window = null
    })
    await window.loadURL(`${origin}/`)
  }
  const extraRoutes = browserRoutes(getTabs)
  if (development) {
    extraRoutes.push(
      [
        'POST',
        /^\/api\/app\/quit$/,
        async () => {
          setTimeout(() => app.quit(), 100)
          return { ok: true }
        }
      ],
      [
        'POST',
        /^\/api\/app\/menu$/,
        async (_req, _p, url) => {
          const label = url.searchParams.get('label')
          const find = (menu) =>
            menu?.items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu) : [])]) ?? []
          const item = find(Menu.getApplicationMenu()).find((item) => item.label === label)
          if (!item?.click) {
            throw new Error('Menu action unavailable')
          }
          item.click(item, window)
          return { ok: true, zoom: window.webContents.getZoomLevel() }
        }
      ],
      [
        'GET',
        /^\/api\/app\/screenshot$/,
        async () => ({ raw: await captureWindow(window, tabs), type: 'image/png' })
      ],
      [
        'POST',
        /^\/api\/app\/goto$/,
        async (_req, _p, url) => {
          const target = new URL(url.searchParams.get('path') ?? '/', origin)
          if (target.origin !== origin) {
            throw new Error('Only cockpit paths are allowed')
          }
          await window.webContents.loadURL(target.href)
          return { ok: true }
        }
      ],
      [
        'POST',
        /^\/api\/app\/eval$/,
        async (req) => {
          let js = ''
          for await (const chunk of req) {
            js += chunk
          }
          return { value: await window.webContents.executeJavaScript(js) }
        }
      ],
      [
        'GET',
        /^\/api\/app\/layout$/,
        async () => ({
          main: window?.getContentBounds(),
          browser: tabs?.bounds,
          contents: webContents
            .getAllWebContents()
            .map((c) => ({ id: c.id, type: c.getType(), url: c.getURL() })),
          views: [...(tabs?.tabs.values() ?? [])].map((t) => ({
            id: t.id,
            bounds: t.view.getBounds(),
            z: window.contentView.children.indexOf(t.view)
          }))
        })
      ]
    )
  }
  const server = await startBridge({
    port,
    lanPort,
    staticDir,
    extraRoutes,
    terminalStreaming,
    onMachineInvite,
    captureExitEnvironment,
    onExitRegionWarning,
    clipboardAdapter,
    onClipboardNotice
  })
  origin = `http://127.0.0.1:${server.address().port}`
  // CLI launched inside engine terminals must reach this same instance.
  process.env.OPC_BRIDGE = origin
  listen('browser:bounds', isCockpit, (rect) => {
    browserBounds = validRect(rect) ? rect : null
    placeBrowser()
  })
  handle('browser:list', () => getTabs().list())
  // 加项目时选目录
  handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '加为项目'
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  for (const action of ['open', 'close', 'activate', 'navigate', 'history']) {
    handle(`browser:${action}`, (...args) => getTabs()[action](...args))
  }
  const reopen = (_e, win) => {
    setTimeout(() => {
      if (!window && !win.isDestroyed() && getMainWindow() === win) {
        void attach(win).catch((error) => console.error('[opc] cockpit reopen failed', error))
      }
    }, 0)
  }
  app.on('browser-window-created', reopen)
  async function close() {
    app.removeListener('browser-window-created', reopen)
    for (const name of handlers) {
      ipcMain.removeHandler(name)
    }
    for (const [name, cb] of listeners) {
      ipcMain.removeListener(name, cb)
    }
    destroyViews()
    closeRuntimeConnection()
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })
  }
  try {
    await attach(window)
  } catch (error) {
    await close()
    throw error
  }
  console.log(`[opc] cockpit ready ${origin}`)
  // 菜单「设置」、通知点击等：把 HiveWard 网页切到某个页面（站内路径），并把窗口叫到前面
  function navigate(path) {
    if (!window || window.isDestroyed()) {
      return false
    }
    if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
      if (window.isMinimized()) {
        window.restore()
      }
      window.show()
      window.webContents.focus()
    }
    window.webContents.send('opc:navigate', path)
    return true
  }
  const contents = () => (window && !window.isDestroyed() ? window.webContents : null)
  return { close, navigate, contents }
}
