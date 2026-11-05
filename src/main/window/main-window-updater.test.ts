import { beforeEach, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({ setupAutoUpdater: vi.fn() }))
vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' }, ipcMain: {} }))
vi.mock('../updater', () => ({
  checkForUpdatesFromMenu: vi.fn(),
  downloadUpdate: vi.fn(),
  getUpdateStatus: vi.fn(),
  setupAutoUpdater: fixtures.setupAutoUpdater
}))
vi.mock('../ipc/ui', () => ({
  getTrustedUIRendererWindow: vi.fn(),
  isTrustedUIRenderer: vi.fn()
}))
vi.mock('../updater/electron-updater-proxy-session', () => ({
  applyProxyToElectronUpdaterSession: vi.fn(async () => undefined)
}))

const store = {
  getSettings: () => ({}),
  updateSettings: vi.fn(),
  flushPendingAsync: vi.fn(async () => undefined)
} as never

beforeEach(() => {
  fixtures.setupAutoUpdater.mockClear()
})

it('桌面模式不等窗口初始化更新服务时用 interactive，「重启并更新」才可用', async () => {
  const { setupHeadlessServeAutoUpdater } = await import('./main-window-updater')
  setupHeadlessServeAutoUpdater(store, { updateInstallMode: 'interactive' })
  await vi.waitFor(() => expect(fixtures.setupAutoUpdater).toHaveBeenCalledTimes(1))
  expect(fixtures.setupAutoUpdater.mock.calls[0][1].installMode).toBe('interactive')
})

it('真正的无窗口服务模式仍是 unsupported-headless-serve', async () => {
  const { setupHeadlessServeAutoUpdater } = await import('./main-window-updater')
  setupHeadlessServeAutoUpdater(store, { updateInstallMode: 'unsupported-headless-serve' })
  await vi.waitFor(() => expect(fixtures.setupAutoUpdater).toHaveBeenCalledTimes(1))
  expect(fixtures.setupAutoUpdater.mock.calls[0][1].installMode).toBe('unsupported-headless-serve')
})
