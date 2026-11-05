import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { dock: { hide: vi.fn() }, setActivationPolicy: vi.fn() } }))

const {
  applyBackgroundActivationPolicy,
  applyServeDesktopWindowActivationPolicy,
  isBackgroundLaunch,
  isHivewarddSidecarLaunch,
  isWindowlessLaunch,
  showWindowWithoutStealingFocus
} = await import('./foreground-activation-policy')

function makeWindow(destroyed = false): BrowserWindow & {
  show: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
} {
  return {
    isDestroyed: () => destroyed,
    show: vi.fn(() => {}),
    showInactive: vi.fn(() => {})
  } as unknown as BrowserWindow & {
    show: ReturnType<typeof vi.fn>
    showInactive: ReturnType<typeof vi.fn>
  }
}

describe('isBackgroundLaunch', () => {
  it('covers headless and headful E2E plus opted-in dev launches', () => {
    expect(isBackgroundLaunch({ HIVEWARD_E2E_HEADLESS: '1' })).toBe(true)
    expect(isBackgroundLaunch({ HIVEWARD_E2E_HEADFUL: '1' })).toBe(true)
    expect(isBackgroundLaunch({ HIVEWARD_BACKGROUND_LAUNCH: '1' })).toBe(true)
    expect(isBackgroundLaunch({})).toBe(false)
  })

  it('keeps an explicit background request despite inherited foreground flags', () => {
    expect(isBackgroundLaunch({ HIVEWARD_BACKGROUND_LAUNCH: '1', HIVEWARD_E2E_FOREGROUND: '1' })).toBe(true)
  })

  it('treats the hivewardd browser sidecar as an explicit background launch', () => {
    expect(isHivewarddSidecarLaunch({ HIVEWARD_HIVEWARDD_SIDECAR: '1' })).toBe(true)
    expect(isHivewarddSidecarLaunch({})).toBe(false)
    expect(isBackgroundLaunch({ HIVEWARD_HIVEWARDD_SIDECAR: '1', HIVEWARD_E2E_FOREGROUND: '1' })).toBe(true)
    expect(isWindowlessLaunch({ HIVEWARD_HIVEWARDD_SIDECAR: '1', HIVEWARD_E2E_HEADFUL: '1' })).toBe(true)
  })

  it('lets native-focus specs opt back into the foreground', () => {
    expect(isBackgroundLaunch({ HIVEWARD_E2E_HEADFUL: '1', HIVEWARD_E2E_FOREGROUND: '1' })).toBe(false)
    expect(isWindowlessLaunch({ HIVEWARD_E2E_HEADLESS: '1', HIVEWARD_E2E_FOREGROUND: '1' })).toBe(false)
  })
})

describe('isWindowlessLaunch', () => {
  it('keeps explicit background launches hidden while headful E2E can paint', () => {
    expect(isWindowlessLaunch({ HIVEWARD_E2E_HEADLESS: '1' })).toBe(true)
    expect(isWindowlessLaunch({ HIVEWARD_E2E_HEADLESS: '1', HIVEWARD_E2E_HEADFUL: '1' })).toBe(false)
    expect(isWindowlessLaunch({ HIVEWARD_BACKGROUND_LAUNCH: '1' })).toBe(true)
    expect(
      isWindowlessLaunch({
        HIVEWARD_BACKGROUND_LAUNCH: '1',
        HIVEWARD_E2E_HEADFUL: '1',
        HIVEWARD_E2E_FOREGROUND: '1'
      })
    ).toBe(true)
  })
})

describe('showWindowWithoutStealingFocus', () => {
  it('keeps a headless window off screen', () => {
    const window = makeWindow()
    showWindowWithoutStealingFocus(window, { HIVEWARD_E2E_HEADLESS: '1' })
    expect(window.show).not.toHaveBeenCalled()
    expect(window.showInactive).not.toHaveBeenCalled()
  })

  it('never reveals an explicitly background window', () => {
    const window = makeWindow()
    showWindowWithoutStealingFocus(window, { HIVEWARD_BACKGROUND_LAUNCH: '1' })
    expect(window.showInactive).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
  })

  it('still reveals explicitly headful E2E without activation', () => {
    const window = makeWindow()
    showWindowWithoutStealingFocus(window, { HIVEWARD_E2E_HEADFUL: '1' })
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(window.show).not.toHaveBeenCalled()
  })

  it('shows normally for a real user launch', () => {
    const window = makeWindow()
    showWindowWithoutStealingFocus(window, {})
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.showInactive).not.toHaveBeenCalled()
  })

  it('ignores a destroyed window', () => {
    const window = makeWindow(true)
    showWindowWithoutStealingFocus(window, {})
    expect(window.show).not.toHaveBeenCalled()
  })
})

describe('applyBackgroundActivationPolicy', () => {
  function makeApp() {
    return {
      dock: { hide: vi.fn(() => {}), show: vi.fn(async () => {}) },
      setActivationPolicy: vi.fn((_policy: 'accessory' | 'prohibited' | 'regular') => {})
    }
  }

  it.each(['HIVEWARD_E2E_HEADLESS', 'HIVEWARD_BACKGROUND_LAUNCH', 'HIVEWARD_HIVEWARDD_SIDECAR'])(
    'drops the macOS Dock tile and menu bar for %s',
    (flag) => {
      const app = makeApp()
      expect(
        applyBackgroundActivationPolicy({
          app,
          env: { [flag]: '1' },
          platform: 'darwin'
        })
      ).toBe(true)
      expect(app.dock.hide).toHaveBeenCalledOnce()
      expect(app.setActivationPolicy).toHaveBeenCalledWith('accessory')
    }
  )

  it('leaves a headful or user launch with its normal Dock presence', () => {
    const headful = makeApp()
    applyBackgroundActivationPolicy({
      app: headful,
      env: { HIVEWARD_E2E_HEADLESS: '1', HIVEWARD_E2E_HEADFUL: '1' },
      platform: 'darwin'
    })
    expect(headful.setActivationPolicy).not.toHaveBeenCalled()

    const user = makeApp()
    applyBackgroundActivationPolicy({ app: user, env: {}, platform: 'darwin' })
    expect(user.setActivationPolicy).not.toHaveBeenCalled()
  })

  it('keeps a windowless macOS serve out of the Dock until it hosts a desktop window', () => {
    const app = makeApp()
    expect(
      applyBackgroundActivationPolicy({
        app,
        env: {},
        platform: 'darwin',
        serveWithoutDesktopWindow: true
      })
    ).toBe(true)
    expect(app.setActivationPolicy).toHaveBeenLastCalledWith('accessory')

    expect(applyServeDesktopWindowActivationPolicy({ app, env: {}, platform: 'darwin' })).toBe(true)
    expect(app.setActivationPolicy).toHaveBeenLastCalledWith('regular')
    expect(app.dock.show).toHaveBeenCalledOnce()
  })

  it('never gives a background serve its Dock tile back', () => {
    const app = makeApp()
    expect(
      applyServeDesktopWindowActivationPolicy({
        app,
        env: { HIVEWARD_BACKGROUND_LAUNCH: '1' },
        platform: 'darwin'
      })
    ).toBe(false)
    expect(
      applyServeDesktopWindowActivationPolicy({
        app,
        env: { HIVEWARD_E2E_HEADFUL: '1' },
        platform: 'darwin'
      })
    ).toBe(false)
    expect(app.setActivationPolicy).not.toHaveBeenCalled()
  })

  it('is a no-op off macOS', () => {
    const app = makeApp()
    expect(
      applyBackgroundActivationPolicy({
        app,
        env: { HIVEWARD_E2E_HEADLESS: '1' },
        platform: 'win32'
      })
    ).toBe(false)
    expect(app.dock.hide).not.toHaveBeenCalled()
  })
})
