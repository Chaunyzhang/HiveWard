import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { start, stop, initialize, clear, createTab, listTabs } = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  initialize: vi.fn(),
  clear: vi.fn(),
  createTab: vi.fn(),
  listTabs: vi.fn()
}))
vi.mock('./external-chromium-browser-session', () => ({
  ExternalChromiumBrowserSession: class {
    start = start
    stop = stop
  }
}))
vi.mock('./external-chromium-tab-registry', () => ({
  ExternalChromiumTabRegistry: class {
    initialize = initialize
    clear = clear
    createTab = createTab
    listTabs = listTabs
  }
}))

import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'
import { startHivewarddBrowserProvider } from './hivewardd-browser-startup'
import { resolveHivewarddBrowserProvider } from './hivewardd-browser-provider'
import {
  createRuntimeBrowserCommands,
  setRuntimeBrowserCommandsFactory
} from '../runtime/runtime-browser-commands-factory'
import type { RuntimeBrowserCommandHost } from '../runtime/browser/browser-command-contracts'
import { RuntimeBrowserPageRegistry } from '../runtime/runtime-browser-page-registry'

vi.mock('./hivewardd-browser-provider', () => ({ resolveHivewarddBrowserProvider: vi.fn() }))
afterEach(() => setRuntimeBrowserCommandsFactory(null))

describe('external Chromium startup cancellation', () => {
  beforeEach(() => vi.resetAllMocks())

  it('does not publish a session that resolves after cancellation and permits cleanup', async () => {
    const controller = new AbortController()
    start.mockImplementation(async () => {
      controller.abort()
      return 'tab-live'
    })
    const browser = new ExternalChromiumBrowserProcess(
      '/opt/hiveward/agent-browser',
      { executablePath: '/opt/hiveward/chromium', provider: 'chromium' },
      '/state'
    )
    await expect(browser.start(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(start).toHaveBeenCalledWith(controller.signal)
    expect(initialize).not.toHaveBeenCalled()
    expect(browser.isAvailable()).toBe(false)
    await browser.stop()
    expect(stop).toHaveBeenCalledWith()
    expect(clear).toHaveBeenCalledOnce()
  })
})

it('forwards tab commands through startup to the Chromium provider', async () => {
  const browser = new ExternalChromiumBrowserProcess(
    '/opt/hiveward/agent-browser',
    { executablePath: '/opt/hiveward/chromium', provider: 'chromium' },
    '/state'
  )
  await browser.start()
  vi.mocked(resolveHivewarddBrowserProvider).mockResolvedValueOnce({
    kind: 'chromium',
    factory: (commandHost) => browser.createCommands(commandHost),
    isAvailable: () => browser.isAvailable(),
    stop: () => browser.stop()
  })
  const startup = startHivewarddBrowserProvider({ userDataPath: '/state' })
  await startup.ready
  try {
    const host: RuntimeBrowserCommandHost = Object.assign(Object.create(null), {
      getRuntimeBrowserPageRegistry: () => new RuntimeBrowserPageRegistry()
    })
    const commands = createRuntimeBrowserCommands(host)
    const params = { worktree: 'wt-a' }
    createTab.mockResolvedValueOnce({ browserPageId: 'page-a' })
    listTabs.mockResolvedValueOnce({ tabs: [] })
    await expect(commands.browserTabCreate(params)).resolves.toEqual({ browserPageId: 'page-a' })
    await expect(commands.browserTabList(params)).resolves.toEqual({ tabs: [] })
    expect(createTab).toHaveBeenCalledWith(host, params)
    expect(listTabs).toHaveBeenCalledWith(host, params)
    const providerCommands = browser.createCommands(host)
    expect('browserTabList' in providerCommands).toBe(true)
    expect('then' in providerCommands).toBe(false)
    expect(Symbol.iterator in providerCommands).toBe(false)
  } finally {
    await startup.stop()
  }
})
