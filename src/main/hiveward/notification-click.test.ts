import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'

const observed = vi.hoisted(() => {
  const state: { open: ReturnType<typeof vi.fn>; notification: EventEmitter | null } = {
    open: vi.fn(),
    notification: null
  }
  return state
})
vi.mock('electron', () => ({
  Notification: class extends EventEmitter {
    constructor() {
      super()
      observed.notification = this
    }
    show() {}
  }
}))
vi.mock('./bridge-service', () => ({ openInHiveWard: observed.open }))
vi.mock('../startup/main-process-state', () => ({
  mainProcessState: { store: { getFolderWorkspaces: () => [] } }
}))
vi.mock('../ipc/macos-notification-center', () => ({ macosNotificationIdentity: () => ({}) }))
vi.mock('../ipc/notification-permission-probe', () => ({
  recordNotificationDeliveryOutcome: vi.fn()
}))
vi.mock('../ipc/native-notification-lifecycle', () => ({
  activeNotificationsById: new Map(),
  logNativeNotificationFailure: vi.fn(),
  retainNotificationUntilRelease: () => vi.fn(),
  waitForNotificationDisplay: vi.fn()
}))
import { deliverNativeNotification } from '../ipc/native-notification-delivery'
it('routes a native notification click into the HiveWard project page', () => {
  deliverNativeNotification(
    { source: 'agent-task-complete', worktreeId: 'repo::/tmp/project with space' },
    { title: '任务完成', body: 'OK' },
    getDefaultNotificationSettings()
  )
  observed.notification?.emit('click')
  expect(observed.open).toHaveBeenCalledWith('/go?path=%2Ftmp%2Fproject%20with%20space')
})
