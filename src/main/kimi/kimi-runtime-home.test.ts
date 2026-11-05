import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const homeMocks = vi.hoisted(() => ({ existingFiles: new Set<string>() }))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => homeMocks.existingFiles.has(path)
}))

const wslMocks = vi.hoisted(() => ({
  listWslDistrosAsync: vi.fn<() => Promise<string[]>>(),
  listRunningWslDistrosAsync: vi.fn<() => Promise<string[]>>(),
  getWslHomeAsync: vi.fn<(distro: string) => Promise<string | null>>()
}))

vi.mock('../wsl', () => wslMocks)
vi.mock('node:os', () => ({ homedir: () => 'C:\\Users\\neil' }))

import { getHostKimiConfigHome, getHostKimiHome, resolveKimiHome } from './kimi-runtime-home'

describe('getHostKimiConfigHome', () => {
  const hostHome = 'C:\\Users\\neil'
  const originalKimiCodeHome = process.env.KIMI_CODE_HOME
  const originalKimiShareDir = process.env.KIMI_SHARE_DIR

  beforeEach(() => {
    homeMocks.existingFiles.clear()
    delete process.env.KIMI_CODE_HOME
    delete process.env.KIMI_SHARE_DIR
  })

  afterEach(() => {
    if (originalKimiCodeHome === undefined) {
      delete process.env.KIMI_CODE_HOME
    } else {
      process.env.KIMI_CODE_HOME = originalKimiCodeHome
    }
    if (originalKimiShareDir === undefined) {
      delete process.env.KIMI_SHARE_DIR
    } else {
      process.env.KIMI_SHARE_DIR = originalKimiShareDir
    }
  })

  it('defaults to the current ~/.kimi config home', () => {
    expect(getHostKimiConfigHome()).toBe(join(hostHome, '.kimi'))
  })

  it('prioritizes KIMI_SHARE_DIR over the explicit legacy override', () => {
    process.env.KIMI_SHARE_DIR = 'D:\\kimi-share'
    process.env.KIMI_CODE_HOME = 'D:\\kimi-legacy-override'
    expect(getHostKimiConfigHome()).toBe('D:\\kimi-share')
  })

  it('retains an explicit KIMI_CODE_HOME override', () => {
    process.env.KIMI_CODE_HOME = 'D:\\kimi-legacy-override'
    expect(getHostKimiConfigHome()).toBe('D:\\kimi-legacy-override')
  })

  it('uses an existing legacy config only when the current config is absent', () => {
    const currentConfig = join(hostHome, '.kimi', 'config.toml')
    const legacyConfig = join(hostHome, '.kimi-code', 'config.toml')
    homeMocks.existingFiles.add(legacyConfig)
    expect(getHostKimiConfigHome()).toBe(join(hostHome, '.kimi-code'))
    homeMocks.existingFiles.add(currentConfig)
    expect(getHostKimiConfigHome()).toBe(join(hostHome, '.kimi'))
  })
})

describe('resolveKimiHome', () => {
  const originalKimiCodeHome = process.env.KIMI_CODE_HOME

  beforeEach(() => {
    delete process.env.KIMI_CODE_HOME
    wslMocks.listWslDistrosAsync.mockReset().mockResolvedValue(['Ubuntu'])
    wslMocks.listRunningWslDistrosAsync.mockReset().mockResolvedValue(['Ubuntu'])
    wslMocks.getWslHomeAsync.mockReset().mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\neil')
  })

  afterEach(() => {
    if (originalKimiCodeHome === undefined) {
      delete process.env.KIMI_CODE_HOME
    } else {
      process.env.KIMI_CODE_HOME = originalKimiCodeHome
    }
  })

  it('ignores the host KIMI_CODE_HOME when reading a WSL home', async () => {
    process.env.KIMI_CODE_HOME = 'D:\\kimi-home'
    expect((await resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).path).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\neil\\.kimi-code'
    )
  })

  it('reports no path without probing the home while the distro is stopped', async () => {
    wslMocks.listRunningWslDistrosAsync.mockResolvedValue([])
    expect(await resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      path: null
    })
    expect(wslMocks.getWslHomeAsync).not.toHaveBeenCalled()
  })

  it('never probes WSL off Windows', async () => {
    expect(await resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'darwin')).toEqual({
      runtime: 'host',
      wslDistro: null,
      path: getHostKimiHome()
    })
    expect(wslMocks.listWslDistrosAsync).not.toHaveBeenCalled()
    expect(wslMocks.getWslHomeAsync).not.toHaveBeenCalled()
  })
})
