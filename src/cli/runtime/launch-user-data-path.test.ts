import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { hivewardProduct } from '../../shared/hiveward-policy'
import { getPlatformUserDataPath } from './metadata'
import { getMacOpenArgs } from './launch'
import { pinLaunchUserDataPath, resolveLaunchUserDataPath } from './launch-user-data-path'

describe('resolveLaunchUserDataPath', () => {
  it('prefers HIVEWARD_USER_DATA_PATH, made absolute', () => {
    expect(
      resolveLaunchUserDataPath({
        HIVEWARD_USER_DATA_PATH: 'rel/profile',
        HIVEWARD_DEV_USER_DATA_PATH: '/dev',
        HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT: '1'
      })
    ).toBe(resolve('rel/profile'))
  })

  it("falls back to the dev app's own profile for a dev executable", () => {
    // 新开发目录还没迁移时，沿用本机已有的旧开发目录（迁移暂缓兼容）。
    const parent = join(getPlatformUserDataPath(), '..')
    const current = resolve(join(parent, hivewardProduct.devDataDirectory))
    const legacy = resolve(join(parent, 'OPC-Engine-Dev'))
    expect(resolveLaunchUserDataPath({ HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT: '1' })).toBe(
      existsSync(current) || !existsSync(legacy) ? current : legacy
    )
  })

  it('ignores HIVEWARD_DEV_USER_DATA_PATH for a packaged executable', () => {
    expect(resolveLaunchUserDataPath({ HIVEWARD_DEV_USER_DATA_PATH: '/dev' })).toBe(
      getPlatformUserDataPath()
    )
  })
})

describe('pinLaunchUserDataPath', () => {
  it('sets the dev override only for a dev executable', () => {
    expect(pinLaunchUserDataPath(['--no-sandbox'], {}, '/p')).toEqual({
      args: ['--no-sandbox', '--user-data-dir=/p'],
      env: { HIVEWARD_USER_DATA_PATH: '/p' }
    })
    expect(
      pinLaunchUserDataPath([], { HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT: '1' }, '/p').env
    ).toMatchObject({ HIVEWARD_DEV_USER_DATA_PATH: '/p' })
  })
})

describe('getMacOpenArgs', () => {
  it('reopens the bundle as before on the default profile', () => {
    expect(getMacOpenArgs('/Applications/HiveWard.app', getPlatformUserDataPath())).toEqual([
      '/Applications/HiveWard.app'
    ])
  })

  it('starts a new instance on another profile instead of activating the running app', () => {
    expect(getMacOpenArgs('/Applications/HiveWard.app', '/isolated/p')).toEqual([
      '-n',
      '/Applications/HiveWard.app',
      '--args',
      '--user-data-dir=/isolated/p'
    ])
  })
})

const testHomes: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(testHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('迁移暂缓时正式版和 dev CLI 都定位旧资料，完成后定位新资料', async () => {
  const home = await mkdtemp('/tmp/hiveward-launch-profile-')
  testHomes.push(home)
  vi.stubEnv('HOME', home)
  vi.stubEnv('APPDATA', join(home, 'config'))
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'))
  const base = dirname(getPlatformUserDataPath())
  for (const [legacy, current, env] of [
    ['OPC-Engine', 'HiveWard', {}],
    ['OPC-Engine-Dev', 'HiveWard-Dev', { HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT: '1' }]
  ] as const) {
    const oldPath = join(base, legacy)
    const newPath = join(base, current)
    await mkdir(oldPath, { recursive: true })
    await mkdir(newPath, { recursive: true })
    expect(resolveLaunchUserDataPath(env)).toBe(oldPath)
    await writeFile(
      join(newPath, '.hiveward-migration.json'),
      JSON.stringify({ phase: 'complete' })
    )
    expect(resolveLaunchUserDataPath(env)).toBe(newPath)
  }
})
