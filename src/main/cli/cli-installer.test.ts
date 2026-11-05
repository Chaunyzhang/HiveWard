import { hivewardProduct } from '../../shared/hiveward-policy'

const originalCliRegistration = hivewardProduct.globalCliRegistration
beforeCliRegistration(() => {
  hivewardProduct.globalCliRegistration = true
})
afterCliRegistration(() => {
  hivewardProduct.globalCliRegistration = originalCliRegistration
})
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  beforeEach as beforeCliRegistration,
  afterEach as afterCliRegistration
} from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

import { CliInstaller } from './cli-installer'
import { makeFixture } from './cli-installer-test-fixtures'
import { resolveAppImageExtractedRoot } from './appimage-extracted-root'
import { buildLegacyAppImageCliWrapper } from './legacy-appimage-cli-wrapper'

// Match --appimage-extract's output directory under cwd.
async function fakeAppImageExtractRunner(_appImagePath: string, cwd: string): Promise<void> {
  const launcherDir = join(cwd, 'squashfs-root', 'resources', 'bin')
  await mkdir(launcherDir, { recursive: true })
  await writeFile(join(launcherDir, 'hiveward'), '#!/usr/bin/env bash\n', {
    encoding: 'utf8',
    mode: 0o755
  })
}

describe('CliInstaller', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.skipIf(process.platform === 'win32')(
    'creates a linux symlink under the requested path and warns when PATH is missing',
    async () => {
      const fixture = await makeFixture()
      const installPath = join(fixture.root, '.local', 'bin', 'hiveward')
      const installer = new CliInstaller({
        homePath: join(fixture.root, 'home'),
        platform: 'linux',
        isPackaged: false,
        userDataPath: fixture.userDataPath,
        execPath: '/opt/HiveWard/hiveward',
        appPath: fixture.appPath,
        commandPathOverride: installPath,
        processPathEnv: '/usr/bin'
      })

      const installed = await installer.install()
      expect(installed.state).toBe('installed')
      expect(installed.commandName).toBe('hiveward')
      expect(installed.pathConfigured).toBe(false)
      expect(installed.detail).toContain('.local')

      const launcherContent = await readFile(installed.launcherPath as string, 'utf8')
      expect(launcherContent).toContain('ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$CLI" "$@"')
      expect(launcherContent).toContain(`export HIVEWARD_USER_DATA_PATH='${fixture.userDataPath}'`)

      const removed = await installer.remove()
      expect(removed.state).toBe('not_installed')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses a separate hiveward-dev command for default development installs',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const commandDir = join(homePath, '.local', 'bin')
      const installer = new CliInstaller({
        platform: 'linux',
        isPackaged: false,
        userDataPath: fixture.userDataPath,
        execPath: '/opt/HiveWard/hiveward',
        appPath: fixture.appPath,
        homePath,
        processPathEnv: commandDir
      })

      const installed = await installer.install()
      expect(installed.state).toBe('installed')
      expect(installed.commandName).toBe('hiveward-dev')
      expect(installed.commandPath).toBe(join(commandDir, 'hiveward-dev'))
      expect(installed.launcherPath).toBe(join(fixture.userDataPath, 'cli', 'bin', 'hiveward-dev'))
      await expect(readlink(installed.commandPath as string)).resolves.toBe(installed.launcherPath)
      await expect(
        readFile(join(fixture.userDataPath, 'cli', 'bin', 'hiveward'), 'utf8')
      ).resolves.toBe(await readFile(installed.launcherPath as string, 'utf8'))
    }
  )

  // Extraction avoids the ephemeral FUSE mount and AppRun's --no-sandbox injection into node mode.
  it.skipIf(process.platform === 'win32')(
    'symlinks the linux command at the extracted AppImage launcher',
    async () => {
      const fixture = await makeFixture()
      const commandDir = join(fixture.root, '.local', 'bin')
      const installPath = join(commandDir, 'hiveward')
      const appImagePath = join(fixture.root, 'HiveWard.AppImage')
      const cacheRootPath = join(fixture.root, 'cache')
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', {
        encoding: 'utf8',
        mode: 0o755
      })

      const installer = new CliInstaller({
        homePath: join(fixture.root, 'home'),
        platform: 'linux',
        isPackaged: true,
        userDataPath: fixture.userDataPath,
        appPath: fixture.appPath,
        appImagePath,
        appImageCacheRootPath: cacheRootPath,
        appImageExtractRunner: fakeAppImageExtractRunner,
        commandPathOverride: installPath,
        processPathEnv: commandDir
      })

      const initial = await installer.getStatus()
      expect(initial).toMatchObject({ state: 'not_installed', installMethod: 'symlink' })

      const installed = await installer.install()
      expect(installed).toMatchObject({
        state: 'installed',
        commandName: 'hiveward',
        installMethod: 'symlink',
        pathConfigured: true
      })
      // The command target remains stable while its cache endpoint advances generations.
      expect(relative(cacheRootPath, installed.launcherPath as string).split(sep)).toEqual([
        'launcher',
        'hiveward'
      ])
      expect(installed.currentTarget).toBe(installed.launcherPath)
      await expect(readlink(installPath)).resolves.toBe(installed.launcherPath)

      const extractedRoot = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!
      await rm(extractedRoot.rootPath, { recursive: true, force: true })
      await expect(installer.getStatus()).resolves.toMatchObject({ state: 'stale' })
      const repaired = await installer.install()
      expect(repaired.state).toBe('installed')

      const removed = await installer.remove()
      expect(removed.state).toBe('not_installed')
      await expect(lstat(repaired.launcherPath as string)).resolves.toBeDefined()
      expect(
        existsSync(resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!.rootPath)
      ).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    're-extracts and re-points the command when the AppImage is replaced',
    async () => {
      const fixture = await makeFixture()
      const commandDir = join(fixture.root, '.local', 'bin')
      const installPath = join(commandDir, 'hiveward')
      const appImagePath = join(fixture.root, 'HiveWard.AppImage')
      const cacheRootPath = join(fixture.root, 'cache')
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', {
        encoding: 'utf8',
        mode: 0o755
      })
      const makeInstaller = (): CliInstaller =>
        new CliInstaller({
          homePath: join(fixture.root, 'home'),
          platform: 'linux',
          isPackaged: true,
          userDataPath: fixture.userDataPath,
          appPath: fixture.appPath,
          appImagePath,
          appImageCacheRootPath: cacheRootPath,
          appImageExtractRunner: fakeAppImageExtractRunner,
          commandPathOverride: installPath,
          processPathEnv: commandDir
        })

      const first = await makeInstaller().install()
      expect(first.state).toBe('installed')

      await writeFile(appImagePath, '#!/usr/bin/env bash\n# next version\n', {
        encoding: 'utf8',
        mode: 0o755
      })

      await expect(makeInstaller().getStatus()).resolves.toMatchObject({ state: 'stale' })

      const second = await makeInstaller().install()
      expect(second.state).toBe('installed')
      expect(second.launcherPath).toBe(first.launcherPath)
      await expect(readlink(installPath)).resolves.toBe(second.launcherPath)
      const liveRoot = resolveAppImageExtractedRoot({ appImagePath, cacheRootPath })!.rootPath
      expect((await readdir(dirname(liveRoot))).sort()).toEqual(
        [basename(liveRoot), 'source-appimage'].sort()
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'replaces and removes the legacy AppImage wrapper',
    async () => {
      const fixture = await makeFixture()
      const commandDir = join(fixture.root, '.local', 'bin')
      const installPath = join(commandDir, 'hiveward')
      const appImagePath = join(fixture.root, "HiveWard's AppImage.AppImage")
      const cacheRootPath = join(fixture.root, 'cache')
      await mkdir(commandDir, { recursive: true })
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o755 })
      await writeFile(installPath, buildLegacyAppImageCliWrapper(appImagePath), {
        encoding: 'utf8',
        mode: 0o755
      })
      const installer = new CliInstaller({
        homePath: join(fixture.root, 'home'),
        platform: 'linux',
        isPackaged: true,
        userDataPath: fixture.userDataPath,
        appPath: fixture.appPath,
        appImagePath,
        appImageCacheRootPath: cacheRootPath,
        appImageExtractRunner: fakeAppImageExtractRunner,
        commandPathOverride: installPath,
        processPathEnv: commandDir
      })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'stale',
        currentTarget: appImagePath
      })
      await expect(installer.install()).resolves.toMatchObject({ state: 'installed' })
      await expect(readlink(installPath)).resolves.toContain(cacheRootPath)

      await installer.remove()
      await writeFile(installPath, buildLegacyAppImageCliWrapper(appImagePath), {
        encoding: 'utf8',
        mode: 0o755
      })
      await expect(installer.remove()).resolves.toMatchObject({ state: 'not_installed' })
      await expect(lstat(installPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )


})
