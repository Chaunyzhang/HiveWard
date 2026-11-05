import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'

const observed = vi.hoisted(() => {
  const notice: { current: EventEmitter | null } = { current: null }
  return {
    open: vi.fn(),
    focused: false,
    shown: vi.fn(),
    notice
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
      observed.shown(this.options)
    }
  }
}))
vi.mock('./bridge-service', () => ({ openInHiveWard: observed.open }))
vi.mock('../startup/main-process-state', () => ({
  mainProcessState: { mainWindow: { isFocused: () => observed.focused } }
}))
vi.mock('../ipc/native-notification-lifecycle', () => ({
  retainNotificationUntilRelease: () => vi.fn()
}))
import { notifyMachineInvitation } from './machine-invitation-notification'

beforeEach(() => {
  observed.focused = false
  observed.notice.current = null
  vi.clearAllMocks()
})
const invite = {
  machine: { user: 'Alice', name: 'Laptop A', address: '192.168.1.2:18808' },
  organization: { name: 'Studio' }
}
it('shows inviter identity and control warning; click opens machines only on user action', () => {
  notifyMachineInvitation(invite)
  expect(observed.shown).toHaveBeenCalledWith({
    title: '加入 HiveWard 组织邀请',
    body: 'Alice · Laptop A (192.168.1.2:18808) 邀请你加入「Studio」。同意后成员可远程控制本机。'
  })
  expect(observed.open).not.toHaveBeenCalled()
  observed.notice.current?.emit('click')
  expect(observed.open).toHaveBeenCalledWith('/machines')
})
it('leaves foreground confirmation to the web invitation surface', () => {
  observed.focused = true
  notifyMachineInvitation(invite)
  expect(observed.shown).not.toHaveBeenCalled()
})
