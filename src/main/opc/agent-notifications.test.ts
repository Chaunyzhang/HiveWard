import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import type { MobileNotificationEvent } from '../runtime/runtime-mobile-notification-controller'
import { installHiveWardAgentNotifications } from './agent-notifications'

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  attention: vi.fn(),
  focused: false,
  quit: vi.fn()
}))
vi.mock('electron', () => ({
  app: { once: mocks.quit },
  Notification: { isSupported: () => true }
}))
vi.mock('../ipc/native-notification-delivery', () => ({ deliverNativeNotification: mocks.deliver }))
vi.mock('../tray/system-tray', () => ({ setTrayAttention: mocks.attention }))
vi.mock('../startup/main-process-state', () => ({
  mainProcessState: { mainWindow: { isFocused: () => mocks.focused } }
}))

let send: (event: MobileNotificationEvent) => void
let settings = getDefaultNotificationSettings()
beforeEach(() => {
  vi.clearAllMocks()
  mocks.focused = false
  settings = getDefaultNotificationSettings()
  const runtime = {
    onNotificationDispatched: (listener: typeof send) => {
      send = listener
      return vi.fn()
    }
  }
  const store = { getSettings: () => ({ notifications: settings }) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter only reads the supplied subscription and settings.
  installHiveWardAgentNotifications(runtime as never, store as never)
})
it.each(['done', 'waiting', 'blocked'] as const)(
  'delivers host %s news without a renderer',
  (agentState) => {
    send({
      type: 'notification',
      source: 'agent-task-complete',
      title: '消息',
      body: '任务',
      agentState,
      worktreeId: 'repo::/tmp/project'
    })
    expect(mocks.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ agentState, worktreeId: 'repo::/tmp/project' }),
      { title: '消息', body: '任务' },
      settings
    )
  }
)
it('honors host suppression, desktop settings and focused-window suppression', () => {
  const event = {
    type: 'notification',
    source: 'agent-task-complete',
    title: '消息',
    body: '任务'
  } as const
  send({ ...event, desktopAllowed: false })
  send({ ...event, legacySocketAllowed: false })
  settings.enabled = false
  send(event)
  settings.enabled = true
  settings.suppressWhenFocused = true
  mocks.focused = true
  send(event)
  expect(mocks.deliver).not.toHaveBeenCalled()
})
