import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireElectronDebugger } from '../browser/electron-debugger-lease'
import { installBrowserSessionUserAgentPolicy } from '../browser/browser-session-ua'
import { createDesktopPopupHandler } from './desktop-popup-policy'
import type * as BrowserPopupNativeWindow from '../browser/browser-popup-native-window'

const PROCESS_UA = 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36'
const ELECTRON_UA = 'Mozilla/5.0 HiveWard/1.0 Chrome/150.0.0.0 Electron/43.0.0 Safari/537.36'

const popupMocks = vi.hoisted(() => ({
  allowNativeBrowserPopup: vi.fn(),
  openPopupWithOriginBar: vi.fn()
}))

vi.mock('../browser/browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({
    mode: 'clean',
    userAgent: PROCESS_UA,
    electronUserAgent: ELECTRON_UA
  })
}))

type HeaderDetails = {
  url: string
  referrer?: string
  resourceType?: string
  requestHeaders: Record<string, string>
}
type BeforeSendHeaders = (
  details: HeaderDetails,
  callback: (response: { requestHeaders: Record<string, string> }) => void
) => void
type Handler = (...args: unknown[]) => void

const { fakeElectron } = vi.hoisted(() => {
  class FakeDebugger {
    attached = false
    handlers = new Map<string, Handler[]>()
    attach = vi.fn(() => {
      this.attached = true
    })
    detach = vi.fn(() => {
      this.attached = false
      this.emit('detach')
    })
    isAttached = vi.fn(() => this.attached)
    sendCommand = vi.fn((method: string) => {
      if (method === 'Page.captureScreenshot') {
        return Promise.resolve({ data: 'c2hvdA==' })
      }
      if (method === 'Accessibility.getFullAXTree') {
        return Promise.resolve({
          nodes: [
            {
              nodeId: '1',
              role: { value: 'button' },
              name: { value: '保存' },
              backendDOMNodeId: 7,
              properties: []
            }
          ]
        })
      }
      if (method === 'DOM.resolveNode') {
        return Promise.resolve({ object: { objectId: 'node-7' } })
      }
      if (method === 'Runtime.callFunctionOn') {
        return Promise.resolve({ result: { value: true } })
      }
      return Promise.resolve({})
    })
    on(event: string, handler: Handler): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    }
    removeListener(event: string, handler: Handler): void {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((item) => item !== handler)
      )
    }
    emit(event: string): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler()
      }
    }
  }

  class FakeSession {
    beforeSendHeaders?: BeforeSendHeaders
    webRequest = {
      onBeforeSendHeaders: vi.fn((_filter: unknown, listener?: BeforeSendHeaders) => {
        this.beforeSendHeaders = listener
      }),
      onBeforeRequest: vi.fn()
    }
  }

  const sessions = new Map<string, FakeSession>()
  function sessionFor(partition: string): FakeSession {
    let session = sessions.get(partition)
    if (!session) {
      session = new FakeSession()
      sessions.set(partition, session)
    }
    return session
  }

  class FakeWebContents {
    session: FakeSession
    debugger = new FakeDebugger()
    handlers = new Map<string, Handler[]>()
    url = 'about:blank'
    opener: FakeWebContents | null = null
    destroyed = false
    navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false)
    }
    loadURL = vi.fn((url: string) => {
      this.url = url
      return Promise.resolve()
    })
    getURL = vi.fn(() => this.url)
    getTitle = vi.fn(() => '标题')
    isLoading = vi.fn(() => false)
    isDestroyed = vi.fn(() => this.destroyed)
    setWindowOpenHandler = vi.fn()
    close = vi.fn(() => {
      this.destroyed = true
      this.emit('destroyed')
    })
    capturePage = vi.fn(() =>
      Promise.resolve({ isEmpty: () => false, toPNG: () => Buffer.from('capture') })
    )
    constructor(partition: string) {
      this.session = sessionFor(partition)
    }
    on(event: string, handler: Handler): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    }
    once(event: string, handler: Handler): void {
      this.on(event, handler)
    }
    removeListener(event: string, handler: Handler): void {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((item) => item !== handler)
      )
    }
    emit(event: string): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler()
      }
    }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    webContents: FakeWebContents
    visible = true
    bounds: unknown = null
    setBackgroundColor = vi.fn()
    setVisible = vi.fn((visible: boolean) => {
      this.visible = visible
    })
    setBounds = vi.fn((bounds: unknown) => {
      this.bounds = bounds
    })
    constructor(options: { webPreferences: { partition: string } }) {
      this.webContents = new FakeWebContents(options.webPreferences.partition)
      FakeWebContentsView.instances.push(this)
    }
  }

  function createWindow() {
    const children: FakeWebContentsView[] = []
    return {
      webContents: new FakeWebContents('persist:hiveward-cockpit'),
      contentView: {
        children,
        addChildView: vi.fn((view: FakeWebContentsView) => {
          const index = children.indexOf(view)
          if (index !== -1) {
            children.splice(index, 1)
          }
          children.push(view)
        }),
        removeChildView: vi.fn((view: FakeWebContentsView) => {
          const index = children.indexOf(view)
          if (index !== -1) {
            children.splice(index, 1)
          }
        })
      },
      isDestroyed: vi.fn(() => false)
    }
  }

  return {
    fakeElectron: {
      FakeWebContentsView,
      createWindow,
      createContents: (partition: string) => new FakeWebContents(partition),
      sessions
    }
  }
})

vi.mock('electron', () => ({ WebContentsView: fakeElectron.FakeWebContentsView }))
vi.mock('../browser/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: popupMocks.openPopupWithOriginBar
}))
vi.mock('../browser/browser-popup-native-window', async (importOriginal) => {
  const actual = await importOriginal<typeof BrowserPopupNativeWindow>()
  return { ...actual, allowNativeBrowserPopup: popupMocks.allowNativeBrowserPopup }
})

import { automationRoutes } from '../../../hiveward/desktop/automation.mjs'
import { BrowserTabs } from '../../../hiveward/desktop/browser.mjs'
import { captureWindow } from '../../../hiveward/desktop/capture-window.mjs'

function createTabs() {
  const window = fakeElectron.createWindow()
  const tabs = new BrowserTabs(window, {
    installSessionUserAgent: installBrowserSessionUserAgentPolicy,
    acquireDebugger: acquireElectronDebugger,
    createPopupHandler: createDesktopPopupHandler
  })
  return { tabs, window }
}

function headersFor(
  session: { beforeSendHeaders?: BeforeSendHeaders },
  details: HeaderDetails
): Record<string, string> {
  const callback = vi.fn()
  session.beforeSendHeaders?.(details, callback)
  expect(callback).toHaveBeenCalledOnce()
  return callback.mock.calls[0][0].requestHeaders
}

const customHeaders = () => ({
  'User-Agent': 'CustomAgent/1.0',
  'Sec-CH-UA': '"Custom";v="1"',
  'sec-ch-ua-mobile': '?1',
  Accept: 'text/html'
})

const tabIntent = (
  url: string,
  disposition: 'foreground-tab' | 'background-tab' = 'foreground-tab'
) => ({
  url,
  frameName: '',
  features: '',
  disposition,
  postBody: null
})

beforeEach(() => {
  fakeElectron.sessions.clear()
  fakeElectron.FakeWebContentsView.instances.length = 0
  popupMocks.openPopupWithOriginBar.mockReset()
  popupMocks.allowNativeBrowserPopup.mockReset()
  popupMocks.openPopupWithOriginBar.mockImplementation((childOptions, _url, prepare) => {
    const contents = childOptions.nativeWindow?.webContents ?? childOptions.webContents
    if (!contents) {
      throw new Error('测试弹窗必须提供 Chromium contents')
    }
    const listeners: (() => void)[] = []
    let closed = false
    const popup = {
      contentWebContents: contents,
      close: vi.fn(() => {
        if (closed) {
          return
        }
        closed = true
        for (const listener of listeners.splice(0)) {
          listener()
        }
      }),
      onClosed: vi.fn((listener: () => void) => {
        if (closed) {
          listener()
        } else {
          listeners.push(listener)
        }
      })
    }
    if (prepare && !prepare(contents)) {
      popup.close()
    }
    return popup
  })
  popupMocks.allowNativeBrowserPopup.mockImplementation(({ opener, options }) => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      ...options,
      webPreferences: { ...options.webPreferences, session: opener.session }
    }
  }))
})

describe('HiveWard desktop browser Google identity', () => {
  it('installs the engine policy on cockpit and every profile before navigation', () => {
    const { tabs, window } = createTabs()
    expect(window.webContents.session.beforeSendHeaders).toBeDefined()

    const tab = tabs.open({ url: 'https://accounts.google.com/v3/signin', profile: 'alpha' })
    const contents = tabs.webContents(tab.id)
    expect(contents.session.beforeSendHeaders).toBeDefined()
    expect(contents.loadURL).toHaveBeenCalledWith('https://accounts.google.com/v3/signin')

    const headers = headersFor(contents.session, {
      url: 'https://accounts.google.com/v3/signin',
      resourceType: 'mainFrame',
      requestHeaders: customHeaders()
    })
    expect(headers).toEqual({ 'User-Agent': ELECTRON_UA, Accept: 'text/html' })
    expect(contents.debugger.attach).not.toHaveBeenCalled()

    const other = tabs.open({ profile: 'beta' })
    expect(tabs.webContents(other.id).session).not.toBe(contents.session)
    expect(tabs.webContents(other.id).session.beforeSendHeaders).toBeDefined()
  })

  it('uses the Google identity for auth-referrer subresources only', () => {
    const { tabs } = createTabs()
    const tab = tabs.open({ profile: 'alpha' })
    const session = tabs.webContents(tab.id).session
    const headers = headersFor(session, {
      url: 'https://www.gstatic.com/signin/assets.js',
      referrer: 'https://accounts.google.com/v3/signin',
      resourceType: 'script',
      requestHeaders: customHeaders()
    })
    expect(headers).toEqual({ 'User-Agent': ELECTRON_UA, Accept: 'text/html' })
  })

  it('restores ordinary headers for a non-login main frame', () => {
    const { tabs } = createTabs()
    const tab = tabs.open({ profile: 'alpha' })
    const original = customHeaders()
    const headers = headersFor(tabs.webContents(tab.id).session, {
      url: 'https://example.com/welcome',
      referrer: 'https://accounts.google.com/v3/signin',
      resourceType: 'mainFrame',
      requestHeaders: { ...original }
    })
    expect(headers).toEqual(original)
  })

  it('keeps login popups on the same partition and policy', () => {
    const { tabs } = createTabs()
    const parent = tabs.open({ profile: 'alpha', by: 'terminal-1' })
    const opener = tabs.webContents(parent.id)
    const openWindow = opener.setWindowOpenHandler.mock.calls[0][0]
    expect(openWindow(tabIntent('https://accounts.youtube.com/signin'))).toEqual({ action: 'deny' })

    const popupInfo = tabs.list().find((tab) => tab.id !== parent.id)
    const popup = tabs.webContents(popupInfo.id)
    expect(popupInfo.by).toBe('terminal-1')
    expect(popup.session).toBe(opener.session)
    expect(popup.session.webRequest.onBeforeSendHeaders).toHaveBeenCalledOnce()
    expect(
      headersFor(popup.session, {
        url: 'https://accounts.youtube.com/signin',
        resourceType: 'mainFrame',
        requestHeaders: customHeaders()
      })
    ).toEqual({ 'User-Agent': ELECTRON_UA, Accept: 'text/html' })
    expect(popup.debugger.attach).not.toHaveBeenCalled()
  })
})

describe('HiveWard desktop debugger lifetime', () => {
  it('reattaches for each Agent command and preserves snapshot refs', async () => {
    const { tabs } = createTabs()
    const tab = tabs.open({ profile: 'alpha' })
    const contents = tabs.webContents(tab.id)
    let body: Record<string, unknown> = {}
    const route = automationRoutes(
      () => tabs,
      async () => body
    )[0][2]

    const snapshot = await route({}, [tab.id, 'snapshot'])
    expect(snapshot.refs.e1).toEqual({ role: 'button', name: '保存' })
    expect(contents.debugger.isAttached()).toBe(false)
    expect(contents.debugger.detach).toHaveBeenCalledOnce()

    body = { what: 'text', ref: snapshot.refs.e1 ? 'e1' : 'missing' }
    await expect(route({}, [tab.id, 'get'])).resolves.toEqual({ value: true })
    expect(contents.debugger.attach).toHaveBeenCalledTimes(2)
    expect(contents.debugger.detach).toHaveBeenCalledTimes(2)
    expect(
      contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'DOM.enable')
    ).toHaveLength(2)

    body = { what: 'unsupported' }
    await expect(route({}, [tab.id, 'get'])).rejects.toMatchObject({ status: 400 })
    expect(contents.debugger.isAttached()).toBe(false)
    expect(contents.debugger.detach).toHaveBeenCalledTimes(3)
  })

  it('releases the debugger after tab and cockpit screenshot fallbacks', async () => {
    const { tabs, window } = createTabs()
    const tab = tabs.open({ profile: 'alpha' })
    const contents = tabs.webContents(tab.id)
    contents.capturePage.mockRejectedValue(new Error('no frame'))

    await expect(tabs.screenshot(tab.id)).resolves.toEqual(Buffer.from('shot'))
    expect(contents.debugger.attach).toHaveBeenCalledOnce()
    expect(contents.debugger.detach).toHaveBeenCalledOnce()
    expect(contents.debugger.isAttached()).toBe(false)

    window.webContents.capturePage.mockRejectedValue(new Error('no frame'))
    await expect(captureWindow(window, null, acquireElectronDebugger)).resolves.toEqual(
      Buffer.from('shot')
    )
    expect(window.webContents.debugger.attach).toHaveBeenCalledOnce()
    expect(window.webContents.debugger.detach).toHaveBeenCalledOnce()
    expect(window.webContents.debugger.isAttached()).toBe(false)
  })
})

describe('HiveWard desktop browser placement', () => {
  const panel = { x: 210, y: 24, width: 800, height: 600 }

  function visibleViews(tabs: ReturnType<typeof createTabs>['tabs']) {
    return [...tabs.tabs.values()].filter((tab) => tab.view.visible).map((tab) => tab.view)
  }

  it('does not invent bounds or activate a background first tab', () => {
    const { tabs } = createTabs()
    const background = tabs.open({ profile: 'alpha', activate: false })
    const backgroundView = tabs.get(background.id).view
    expect(tabs.active).toBeNull()
    expect(backgroundView.visible).toBe(false)
    expect(backgroundView.setBounds).not.toHaveBeenCalled()

    const active = tabs.open({ profile: 'beta' })
    expect(tabs.active).toBe(active.id)
    expect(visibleViews(tabs)).toEqual([])
    expect(tabs.get(active.id).view.setBounds).not.toHaveBeenCalled()
  })

  it('shows only the active identity across switches and popups', () => {
    const { tabs } = createTabs()
    const first = tabs.open({ profile: 'alpha' })
    const second = tabs.open({ profile: 'beta', activate: false })
    const firstView = tabs.get(first.id).view
    const secondView = tabs.get(second.id).view

    tabs.setBounds(panel)
    expect(visibleViews(tabs)).toEqual([firstView])
    expect(firstView.bounds).toEqual(panel)
    expect(secondView.setBounds).not.toHaveBeenCalled()

    tabs.activate(second.id)
    expect(visibleViews(tabs)).toEqual([secondView])
    expect(secondView.bounds).toEqual(panel)

    const backgroundOpen = firstView.webContents.setWindowOpenHandler.mock.calls[0][0]
    backgroundOpen(tabIntent('https://example.com/background-popup', 'background-tab'))
    const backgroundPopup = tabs
      .list()
      .find((tab) => tab.profile === 'alpha' && tab.id !== first.id)
    expect(tabs.active).toBe(second.id)
    expect(tabs.get(backgroundPopup.id).view.visible).toBe(false)
    expect(visibleViews(tabs)).toEqual([secondView])

    const activeOpen = secondView.webContents.setWindowOpenHandler.mock.calls[0][0]
    activeOpen(tabIntent('https://accounts.google.com/signin'))
    const activePopup = tabs.get(tabs.active).view
    expect(activePopup.webContents.session).toBe(secondView.webContents.session)
    expect(visibleViews(tabs)).toEqual([activePopup])
  })

  it('hides everything for null, zero or negative panel geometry', () => {
    const { tabs } = createTabs()
    const tab = tabs.open({ profile: 'alpha' })
    const view = tabs.get(tab.id).view
    tabs.setBounds(panel)
    view.setBounds.mockClear()

    for (const bounds of [
      null,
      { ...panel, width: 0 },
      { ...panel, height: 0 },
      { ...panel, x: -10 },
      { ...panel, y: -1 }
    ]) {
      tabs.setBounds(bounds)
      expect(view.visible).toBe(false)
      expect(view.setBounds).not.toHaveBeenCalled()
    }

    const resized = { x: 260, y: 32, width: 920, height: 700 }
    tabs.setBounds(resized)
    expect(view.visible).toBe(true)
    expect(view.bounds).toEqual(resized)
    expect(view.setBounds).toHaveBeenCalledOnce()
  })

  it('keeps background tabs hidden when navigating, screenshotting or running Agent commands', async () => {
    const { tabs } = createTabs()
    const shown = tabs.open({ profile: 'alpha' })
    const background = tabs.open({ profile: 'beta', activate: false })
    const shownView = tabs.get(shown.id).view
    const backgroundView = tabs.get(background.id).view
    tabs.setBounds(panel)
    backgroundView.setBounds.mockClear()
    backgroundView.setVisible.mockClear()

    tabs.navigate(background.id, 'https://example.com/background')
    await tabs.screenshot(background.id)
    const route = automationRoutes(
      () => tabs,
      async () => ({ ms: 0 })
    )[0][2]
    await route({}, [background.id, 'wait'])

    expect(tabs.active).toBe(shown.id)
    expect(visibleViews(tabs)).toEqual([shownView])
    expect(backgroundView.setBounds).not.toHaveBeenCalled()
    expect(backgroundView.setVisible).not.toHaveBeenCalledWith(true)
    expect(backgroundView.webContents.debugger.isAttached()).toBe(false)
  })

  it('does not activate a replacement when closing a background tab', () => {
    const { tabs } = createTabs()
    const first = tabs.open({ profile: 'alpha', activate: false })
    const second = tabs.open({ profile: 'beta', activate: false })
    tabs.setBounds(panel)
    expect(visibleViews(tabs)).toEqual([])

    tabs.close(first.id)
    expect(tabs.active).toBeNull()
    expect(tabs.get(second.id).view.visible).toBe(false)
    expect(tabs.get(second.id).view.setBounds).not.toHaveBeenCalled()

    tabs.close(second.id)
    expect(tabs.active).toBeNull()
    expect(tabs.list()).toEqual([])
  })
})

describe('HiveWard desktop opener popups', () => {
  const openerIntent = (url = 'https://accounts.google.com/signin') => ({
    url,
    frameName: 'google-auth',
    features: 'width=520,height=640',
    disposition: 'default',
    postBody: null
  })

  it('keeps an opener popup native on the parent session with recursive policy', () => {
    const { tabs } = createTabs()
    const parent = tabs.open({ profile: 'alpha' })
    const opener = tabs.webContents(parent.id)
    const handler = opener.setWindowOpenHandler.mock.calls[0][0]
    const response = handler(openerIntent())

    expect(response.action).toBe('allow')
    expect(response.overrideBrowserWindowOptions.webPreferences.session).toBe(opener.session)
    expect(response.overrideBrowserWindowOptions.webPreferences.nodeIntegration).toBe(false)

    const child = fakeElectron.createContents('persist:hiveward-alpha')
    child.opener = opener
    expect(response.createWindow({ webContents: child, show: true })).toBe(child)
    expect(popupMocks.openPopupWithOriginBar).toHaveBeenCalledOnce()
    const [popupOptions] = popupMocks.openPopupWithOriginBar.mock.calls[0]
    expect(popupOptions.webPreferences.session).toBe(opener.session)
    expect(child.setWindowOpenHandler).toHaveBeenCalledOnce()

    const childHandler = child.setWindowOpenHandler.mock.calls[0][0]
    expect(childHandler(openerIntent('https://accounts.youtube.com/signin')).action).toBe('allow')
    expect(
      headersFor(child.session, {
        url: 'https://accounts.google.com/signin',
        resourceType: 'mainFrame',
        requestHeaders: customHeaders()
      })
    ).toEqual({ 'User-Agent': ELECTRON_UA, Accept: 'text/html' })

    const popup = popupMocks.openPopupWithOriginBar.mock.results[0].value
    tabs.close(parent.id)
    expect(popup.close).toHaveBeenCalledOnce()
  })

  it('still converts ordinary links to tabs and denies local file popups', () => {
    const { tabs } = createTabs()
    const parent = tabs.open({ profile: 'alpha' })
    const opener = tabs.webContents(parent.id)
    const handler = opener.setWindowOpenHandler.mock.calls[0][0]

    expect(handler(tabIntent('https://example.com/product'))).toEqual({ action: 'deny' })
    expect(tabs.list()).toHaveLength(2)
    expect(tabs.list()[1].url).toBe('https://example.com/product')
    expect(popupMocks.openPopupWithOriginBar).not.toHaveBeenCalled()

    expect(handler(openerIntent('file:///tmp/private.html'))).toEqual({ action: 'deny' })
    expect(tabs.list()).toHaveLength(2)
    expect(popupMocks.openPopupWithOriginBar).not.toHaveBeenCalled()
    expect(popupMocks.allowNativeBrowserPopup).not.toHaveBeenCalled()
  })

  it('does not present a native popup owned by a background tab', () => {
    const { tabs } = createTabs()
    const shown = tabs.open({ profile: 'alpha' })
    const background = tabs.open({ profile: 'beta', activate: false })
    const opener = tabs.webContents(background.id)
    const handler = opener.setWindowOpenHandler.mock.calls[0][0]
    tabs.setBounds({ x: 210, y: 24, width: 800, height: 600 })

    const response = handler(openerIntent())
    expect(response.action).toBe('allow')
    expect(response.overrideBrowserWindowOptions.show).toBe(false)

    const child = fakeElectron.createContents('persist:hiveward-beta')
    child.opener = opener
    response.createWindow({ webContents: child, show: true })
    const [popupOptions] = popupMocks.openPopupWithOriginBar.mock.calls[0]
    expect(popupOptions.show).toBe(false)
    expect(tabs.active).toBe(shown.id)
    expect(tabs.get(background.id).view.visible).toBe(false)
    expect(tabs.get(shown.id).view.visible).toBe(true)

    handler({
      url: 'about:blank',
      frameName: '',
      features: '',
      disposition: 'new-window',
      postBody: null
    })
    const admission = popupMocks.allowNativeBrowserPopup.mock.calls[0][0]
    expect(admission.options.show).toBe(false)
    expect(admission.background).toBe(true)
  })

  it('uses HiveWard native admission for Chromium-created opener windows', () => {
    const { tabs } = createTabs()
    const parent = tabs.open({ profile: 'alpha' })
    const opener = tabs.webContents(parent.id)
    const handler = opener.setWindowOpenHandler.mock.calls[0][0]
    const response = handler({
      url: 'about:blank',
      frameName: '',
      features: '',
      disposition: 'new-window',
      postBody: null
    })

    expect(response.action).toBe('allow')
    expect(response.createWindow).toBeUndefined()
    expect(popupMocks.allowNativeBrowserPopup).toHaveBeenCalledOnce()
    const admission = popupMocks.allowNativeBrowserPopup.mock.calls[0][0]
    expect(admission.opener).toBe(opener)
    expect(admission.options.webPreferences.session).toBe(opener.session)
    expect(admission.background).toBe(false)

    const child = fakeElectron.createContents('persist:hiveward-alpha')
    child.opener = opener
    const nativeWindow = { webContents: child }
    expect(admission.onCreated({ nativeWindow, show: true })).toBe(child)
    const [popupOptions] = popupMocks.openPopupWithOriginBar.mock.calls[0]
    expect(popupOptions.nativeWindow).toBe(nativeWindow)
    expect(child.setWindowOpenHandler).toHaveBeenCalledOnce()
  })
})
