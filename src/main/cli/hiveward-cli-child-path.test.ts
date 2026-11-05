import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const shim = vi.hoisted(() => ({ ensureLinuxTerminalHiveWardCliShimDir: vi.fn() }))
vi.mock('./linux-terminal-hiveward-cli-shim', () => shim)

import { prependHiveWardCliDirToChildPath } from './hiveward-cli-child-path'

const USER_DATA = '/data/hiveward'
const SHIM_DIR = join(USER_DATA, 'linux-hiveward-cli-shim')

beforeEach(() => {
  installFakeAppEnvironment()
  shim.ensureLinuxTerminalHiveWardCliShimDir.mockReset()
  shim.ensureLinuxTerminalHiveWardCliShimDir.mockReturnValue(SHIM_DIR)
})

afterEach(() => installFakeAppEnvironment())

describe('prependHiveWardCliDirToChildPath', () => {
  it.each(['linux', 'darwin'] as const)(
    'uses the %s execution host CLI and profile over inherited values',
    (platform) => {
      const launcher = join(USER_DATA, 'cli', 'bin', 'hiveward')
      installFakeAppEnvironment({ getCliLauncherPath: () => launcher })
      const env: Record<string, string> = {
        PATH: `/usr/bin:${join(USER_DATA, 'cli', 'bin')}::/bin`,
        HIVEWARD_USER_DATA_PATH: '/parent/profile',
        HIVEWARD_CLI_COMMAND: '/parent/hiveward',
        HIVEWARD_CLI_BIN_DIR: '/parent/bin'
      }
      expect(
        prependHiveWardCliDirToChildPath(env, {
          isPackaged: true,
          userDataPath: USER_DATA,
          resourcesPath: null,
          platform
        })
      ).toBe(launcher)
      expect(env.PATH).toBe(`${join(USER_DATA, 'cli', 'bin')}:/usr/bin:/bin`)
      expect(env.HIVEWARD_USER_DATA_PATH).toBe(USER_DATA)
      expect(env.HIVEWARD_CLI_COMMAND).toBe(launcher)
      expect(env.HIVEWARD_CLI_BIN_DIR).toBe(join(USER_DATA, 'cli', 'bin'))
      expect(shim.ensureLinuxTerminalHiveWardCliShimDir).not.toHaveBeenCalled()
    }
  )
  it('exports the owning packaged Linux launcher and profile together with PATH', () => {
    const env = {
      PATH: `/usr/bin:${SHIM_DIR}::/bin`,
      HIVEWARD_CLI_COMMAND: '/other/hiveward',
      HIVEWARD_USER_DATA_PATH: '/other/profile'
    }
    const launcher = prependHiveWardCliDirToChildPath(env, {
      isPackaged: true,
      userDataPath: USER_DATA,
      platform: 'linux'
    })

    expect(launcher).toBe(join(SHIM_DIR, 'hiveward'))
    expect(env.HIVEWARD_CLI_COMMAND).toBe(launcher)
    expect(env.HIVEWARD_USER_DATA_PATH).toBe(USER_DATA)
    expect(env.PATH).toBe(`${SHIM_DIR}:/usr/bin:/bin`)
  })

  it('puts a Windows execution host CLI first on Path without a POSIX restore dir', () => {
    const binDir = join(USER_DATA, 'cli', 'bin')
    const launcher = join(binDir, 'hiveward.exe')
    installFakeAppEnvironment({ getCliLauncherPath: () => launcher })
    const env: Record<string, string> = {
      Path: `C:\\Windows;${binDir};;C:\\Tools`,
      HIVEWARD_USER_DATA_PATH: 'C:\\parent\\profile',
      HIVEWARD_CLI_COMMAND: 'C:\\parent\\hiveward.exe',
      HIVEWARD_CLI_BIN_DIR: '/parent/bin'
    }
    expect(
      prependHiveWardCliDirToChildPath(env, {
        isPackaged: true,
        userDataPath: USER_DATA,
        resourcesPath: null,
        platform: 'win32'
      })
    ).toBe(launcher)
    expect(env).toEqual({
      Path: `${binDir};C:\\Windows;C:\\Tools`,
      HIVEWARD_USER_DATA_PATH: USER_DATA,
      HIVEWARD_CLI_COMMAND: launcher
    })
  })

  it('writes no trailing delimiter when nothing was inherited', () => {
    const env: Record<string, string> = { PATH: '' }
    const inheritedPath = process.env.PATH
    delete process.env.PATH
    try {
      prependHiveWardCliDirToChildPath(env, {
        isPackaged: false,
        userDataPath: USER_DATA,
        platform: 'linux'
      })
    } finally {
      if (inheritedPath !== undefined) {
        process.env.PATH = inheritedPath
      }
    }
    // Why: an empty trailing segment resolves as `.` in some shells.
    expect(env.PATH).toBe(join(USER_DATA, 'cli', 'bin'))
  })
})
