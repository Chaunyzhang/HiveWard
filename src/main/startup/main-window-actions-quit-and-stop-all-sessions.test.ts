import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  confirmQuitAndStopAllSessions,
  explainStopAllSessionsUnavailable
} from './quit-and-stop-all-sessions-prompt'

const electron = vi.hoisted(() => ({ quit: vi.fn(), showMessageBox: vi.fn() }))
const prompt = vi.hoisted(() => ({
  confirm: vi.fn<typeof confirmQuitAndStopAllSessions>(),
  explain: vi.fn<typeof explainStopAllSessionsUnavailable>()
}))
const daemon = vi.hoisted(() => ({
  killAll: vi.fn(async () => ({ remainingCount: 0 })),
  holdingNewer: vi.fn(() => false),
  provider: vi.fn<() => object | null>(() => ({})),
  noSessionsRemain: vi.fn<() => Promise<boolean>>()
}))

vi.mock('electron', () => ({
  app: { quit: electron.quit },
  dialog: { showMessageBox: electron.showMessageBox }
}))
vi.mock('./quit-and-stop-all-sessions-prompt', () => ({
  confirmQuitAndStopAllSessions: prompt.confirm,
  explainStopAllSessionsUnavailable: prompt.explain
}))
vi.mock('../daemon/daemon-newer-protocol-hold', () => ({
  isHoldingForNewerProtocolDaemon: daemon.holdingNewer
}))
vi.mock('../daemon/daemon-provider-state', () => ({ getDaemonProvider: daemon.provider }))
vi.mock('../ipc/pty/pty-management', () => ({
  killAllDaemonSessions: daemon.killAll,
  confirmNoDaemonSessionsRemain: daemon.noSessionsRemain
}))
vi.mock('../updater', () => ({ checkForUpdatesFromMenu: vi.fn(), isQuittingForUpdate: vi.fn() }))
vi.mock('../tray/system-tray', () => ({
  createSystemTray: vi.fn(),
  setMacMenuBarIconVisible: vi.fn()
}))
vi.mock('../window/main-window-updater', () => ({ ensureAutoUpdaterConfigured: vi.fn() }))
vi.mock('../window/focus-existing-window', () => ({
  focusExistingMainWindow: vi.fn(),
  safelyRevealWindow: vi.fn()
}))
vi.mock('../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))
vi.mock('./windows-install-dir-acl-recovery', () => ({
  describeInstallDirAclPoison: vi.fn(),
  isBlockingInstallDirAclRepairInFlight: vi.fn()
}))
vi.mock('../window/renderer-recovery-prompt', () => ({ presentRendererRecoveryPrompt: vi.fn() }))
vi.mock('../window/renderer-launch-failure-probe', () => ({ probeRendererLaunchCapacity: vi.fn() }))

import { quitAndStopAllSessionsFromUserCommand, quitFromUserCommand } from './main-window-actions'
import { mainProcessState as state } from './main-process-state'

beforeEach(() => {
  vi.clearAllMocks()
  state.isQuitting = false
  state.isServeMode = false
  state.mainWindow = null
  prompt.confirm.mockResolvedValue(true)
  daemon.noSessionsRemain.mockResolvedValue(true)
})

afterEach(() => {
  state.runtime = null
})

describe('main-owned quit', () => {
  it('normal quit leaves sessions alone', () => {
    quitFromUserCommand()
    expect(electron.quit).toHaveBeenCalledOnce()
    expect(daemon.killAll).not.toHaveBeenCalled()
  })
  it('confirmed full quit retires terminals before killing unlisted sessions and quitting', async () => {
    const closeTerminal = vi.fn(async () => ({}))
    Object.assign(state, {
      runtime: { listTerminals: async () => ({ terminals: [{ handle: 'owned' }] }), closeTerminal }
    })
    quitAndStopAllSessionsFromUserCommand()
    await new Promise((resolve) => setImmediate(resolve))
    expect(closeTerminal).toHaveBeenCalledWith('owned')
    expect(daemon.killAll).toHaveBeenCalledOnce()
    expect(electron.quit).toHaveBeenCalledOnce()
  })
  it('stays open if any daemon still owns a session', async () => {
    Object.assign(state, { runtime: { listTerminals: async () => ({ terminals: [] }) } })
    daemon.noSessionsRemain.mockResolvedValue(false)
    quitAndStopAllSessionsFromUserCommand()
    await new Promise((resolve) => setImmediate(resolve))
    expect(electron.quit).not.toHaveBeenCalled()
  })
})
