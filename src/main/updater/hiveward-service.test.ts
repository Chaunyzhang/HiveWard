import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixtures = vi.hoisted(() => ({
  fetch: vi.fn(),
  quit: vi.fn(),
  install: vi.fn(),
  beforeQuit: vi.fn(),
  agents: vi.fn(() => 3),
  native: {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn()
  }
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', once: vi.fn(), quit: fixtures.quit }
}))
vi.mock('../network/http-client', () => ({ getMainHttpClient: () => ({ fetch: fixtures.fetch }) }))
vi.mock('../startup/main-process-state', () => ({
  mainProcessState: { agentAwakeService: { getWorkingAgentCount: fixtures.agents } }
}))
vi.mock('../electron-updater-loader', () => ({ loadElectronAutoUpdater: () => fixtures.native }))
vi.mock('./hiveward-mac-installer', () => ({
  prepareMacUpdate: vi.fn(),
  launchMacInstaller: fixtures.install
}))
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  fixtures.fetch.mockImplementation(async () => new Response(null, { status: 404 }))
})
afterEach(() => {
  vi.useRealTimers()
})
it('启动检查一次，此后每六小时检查', async () => {
  const updater = await import('../updater')
  updater.setupAutoUpdater(null)
  await vi.advanceTimersByTimeAsync(1)
  expect(fixtures.fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
  expect(fixtures.fetch).toHaveBeenCalledTimes(2)
})
it('关闭自动检查后不联网，手动检查仍工作', async () => {
  const updater = await import('../updater')
  let automatic = false
  updater.setupAutoUpdater(null, {
    getAutomatic: () => automatic,
    setAutomatic: (value) => {
      automatic = value
    }
  })
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
  expect(fixtures.fetch).not.toHaveBeenCalled()
  await updater.checkForUpdatesFromMenu()
  expect(fixtures.fetch).toHaveBeenCalledTimes(1)
  updater.setAutomaticUpdateChecks(true)
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
  expect(fixtures.fetch).toHaveBeenCalledTimes(2)
})
it('只读快照不检查外网并包含工作中的 Agent 数量', async () => {
  const updater = await import('../updater')
  expect(await updater.getHiveWardUpdateSnapshot()).toMatchObject({
    appVersion: '1.0.0',
    automatic: true,
    workingAgents: 3
  })
  expect(fixtures.fetch).not.toHaveBeenCalled()
})
it('并发检查合并，网络失败不会变成已是最新', async () => {
  const updater = await import('../updater')
  fixtures.fetch.mockRejectedValue(new Error('offline'))
  await Promise.all([updater.checkForUpdatesFromMenu(), updater.checkForUpdatesFromMenu()])
  // 一次检查：先问接口，连不上再问 github.com 的 latest 跳转
  expect(fixtures.fetch).toHaveBeenCalledTimes(2)
  expect(updater.getUpdateStatus()).toMatchObject({
    state: 'error',
    message: expect.stringContaining('连不上 GitHub（offline）')
  })
})

it('Windows 仅从 HiveWard 下载 NSIS，安装必须确认当前版本和 Agent 数量', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    fixtures.fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: 'v1.1.0',
            draft: false,
            prerelease: false,
            body: '正式说明',
            assets: []
          })
        )
    )
    fixtures.native.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.1.0' } })
    const updater = await import('../updater')
    updater.setupAutoUpdater(null, { getAutomatic: () => false, onBeforeQuit: fixtures.beforeQuit })
    await updater.checkForUpdatesFromMenu()
    await updater.downloadUpdate()
    expect(fixtures.native.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'Chaunyzhang',
      repo: 'HiveWard'
    })
    expect(fixtures.native).toMatchObject({
      allowPrerelease: false,
      allowDowngrade: false,
      autoDownload: false,
      autoInstallOnAppQuit: false
    })
    expect(updater.getUpdateStatus().state).toBe('downloaded')
    await expect(updater.quitAndInstall()).rejects.toThrow('重新确认')
    await expect(updater.quitAndInstall({ version: '1.1.0', workingAgents: 2 })).rejects.toThrow(
      '重新确认'
    )
    expect(fixtures.native.quitAndInstall).not.toHaveBeenCalled()
    await updater.quitAndInstall({ version: '1.1.0', workingAgents: 3 })
    expect(fixtures.beforeQuit).toHaveBeenCalledOnce()
    expect(fixtures.native.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(updater.isQuittingForUpdate()).toBe(true)
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})
it('Windows 检查与下载期间版本变化时拒绝安装', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    fixtures.fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: 'v1.1.0',
            draft: false,
            prerelease: false,
            assets: []
          })
        )
    )
    fixtures.native.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.0' } })
    const updater = await import('../updater')
    await updater.checkForUpdatesFromMenu()
    await updater.downloadUpdate()
    expect(updater.getUpdateStatus()).toMatchObject({
      state: 'error',
      message: '发布版本已变化，请重新检查更新'
    })
    expect(fixtures.native.downloadUpdate).not.toHaveBeenCalled()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})
