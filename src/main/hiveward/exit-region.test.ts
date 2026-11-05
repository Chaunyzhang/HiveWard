import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { LoginShellEnvironmentCapture } from '../startup/login-shell-environment'

const observed = vi.hoisted(() => {
  const notice: { current: EventEmitter | null } = { current: null }
  return {
    notice,
    show: vi.fn(),
    open: vi.fn(),
    capture: vi.fn<() => Promise<LoginShellEnvironmentCapture>>()
  }
})
vi.mock('electron', () => ({
  Notification: class extends EventEmitter {
    static isSupported(): boolean {
      return true
    }
    constructor(readonly options: { title: string; body: string }) {
      super()
      observed.notice.current = this
    }
    show(): void {
      observed.show(this.options)
    }
  }
}))
vi.mock('./bridge-service', () => ({ openInHiveWard: observed.open }))
vi.mock('../ipc/native-notification-lifecycle', () => ({
  retainNotificationUntilRelease: () => vi.fn()
}))
vi.mock('../startup/main-process-state', () => ({
  mainProcessState: { store: { getSettings: () => ({ terminalDefaultShell: '/custom/zsh' }) } }
}))
vi.mock('../startup/login-shell-environment', () => ({
  captureLoginShellEnvironment: observed.capture
}))
vi.mock('../startup/hydrate-shell-path', () => ({ resolveProfileLoadingShell: () => '/bin/bash' }))
import { captureExitRegionEnvironment } from './exit-region-environment'
import { notifyExitRegionWarning } from './exit-region-notification'

beforeEach(() => {
  vi.clearAllMocks()
  observed.notice.current = null
})
it('shows a non-killing warning; only clicking opens the machine page', () => {
  notifyExitRegionWarning({ message: '出口 CN，要求 US；当前进程未自动终止。' })
  expect(observed.show).toHaveBeenCalledWith({
    title: 'Agent 出口地区警告',
    body: '出口 CN，要求 US；当前进程未自动终止。'
  })
  expect(observed.open).not.toHaveBeenCalled()
  observed.notice.current?.emit('click')
  expect(observed.open).toHaveBeenCalledWith('/machines')
})
it('uses a fresh profile capture and refuses the process-environment fallback', async () => {
  observed.capture.mockResolvedValueOnce({
    status: 'captured',
    env: { HTTPS_PROXY: 'http://127.0.0.1:7890' }
  })
  const environment = await captureExitRegionEnvironment()
  expect(environment.env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  expect(observed.capture).toHaveBeenCalledWith(
    expect.objectContaining({
      startedAfter: expect.any(Number),
      shellOverride: process.platform === 'win32' ? '/bin/bash' : '/custom/zsh'
    })
  )
  observed.capture.mockResolvedValueOnce({ status: 'fallback', env: {} })
  await expect(captureExitRegionEnvironment()).rejects.toThrow('shell_environment_unavailable')
})
