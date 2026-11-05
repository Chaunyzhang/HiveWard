import { hivewardProduct } from '../../shared/hiveward-policy'

const originalCliRegistration = hivewardProduct.globalCliRegistration
beforeCliRegistration(() => {
  hivewardProduct.globalCliRegistration = true
})
afterCliRegistration(() => {
  hivewardProduct.globalCliRegistration = originalCliRegistration
})
import { link, lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { createPackagedMacLauncher, makeFixture } from './cli-installer-test-fixtures'

async function makeBundledLauncherFixture() {
  const fixture = await makeFixture()
  const launcher = await readFile(
    join(process.cwd(), 'resources', 'darwin', 'bin', 'hiveward'),
    'utf8'
  )
  const resourcesPath = await createPackagedMacLauncher(fixture.root, launcher)
  const bundledBin = join(resourcesPath, 'bin')
  const launcherPath = join(bundledBin, 'hiveward')
  return {
    root: fixture.root,
    bundledBin,
    installerOptions: {
      platform: 'darwin' as const,
      isPackaged: true,
      resourcesPath,
      userDataPath: fixture.userDataPath,
      execPath: '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
      appPath: fixture.appPath,
      homePath: join(fixture.root, 'home')
    },
    expectLauncherIntact: async () => {
      expect((await lstat(launcherPath)).isSymbolicLink()).toBe(false)
      expect(await readFile(launcherPath, 'utf8')).toBe(launcher)
    }
  }
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
    'falls back to ~/.local/bin/hiveward on macOS when /usr/local/bin does not exist',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const absentUsrLocalBin = join(fixture.root, 'usr', 'local', 'bin', 'hiveward')
      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: absentUsrLocalBin,
        processPathEnv: join(homePath, '.local', 'bin')
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(join(homePath, '.local', 'bin', 'hiveward'))
      expect(status.state).toBe('not_installed')
      expect(status.supported).toBe(true)

      const installed = await installer.install()
      expect(installed.state).toBe('installed')
      expect(installed.commandPath).toBe(join(homePath, '.local', 'bin', 'hiveward'))
      expect(installed.pathConfigured).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses an existing managed macOS hiveward command from the shell PATH before /usr/local/bin',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'hiveward')
      const userInstallPath = join(userLocalBin, 'hiveward')
      const launcherPath = join(resourcesPath, 'bin', 'hiveward')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await symlink(launcherPath, userInstallPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${userLocalBin}:${usrLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.state).toBe('installed')
      expect(status.commandPath).toBe(userInstallPath)
      expect(status.pathConfigured).toBe(true)

      const installed = await installer.install()
      expect(installed.commandPath).toBe(userInstallPath)
      await expect(readlink(userInstallPath)).resolves.toBe(launcherPath)
      await expect(lstat(defaultInstallPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'skips a broken managed macOS hiveward symlink before /usr/local/bin',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'hiveward')
      const userInstallPath = join(userLocalBin, 'hiveward')
      const launcherPath = join(resourcesPath, 'bin', 'hiveward')
      const oldLauncherPath = join(
        fixture.root,
        'Old.app',
        'Contents',
        'Resources',
        'bin',
        'hiveward'
      )
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await symlink(oldLauncherPath, userInstallPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${userLocalBin}:${usrLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status).toMatchObject({
        commandPath: defaultInstallPath,
        state: 'not_installed',
        currentTarget: null
      })

      const installed = await installer.install()
      expect(installed.commandPath).toBe(defaultInstallPath)
      expect(installed.state).toBe('installed')
      await expect(readlink(defaultInstallPath)).resolves.toBe(launcherPath)
      await expect(readlink(userInstallPath)).resolves.toBe(oldLauncherPath)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses a later managed macOS hiveward command when the default command is not executable',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'hiveward')
      const userInstallPath = join(userLocalBin, 'hiveward')
      const launcherPath = join(resourcesPath, 'bin', 'hiveward')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await writeFile(defaultInstallPath, '#!/usr/bin/env bash\necho other-hiveward\n', 'utf8')
      await symlink(launcherPath, userInstallPath)

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${usrLocalBin}:${userLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(userInstallPath)
      expect(status.state).toBe('installed')

      const installed = await installer.install()
      expect(installed.commandPath).toBe(userInstallPath)
      await expect(readFile(defaultInstallPath, 'utf8')).resolves.toContain('other-hiveward')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'installs the default macOS command instead of replacing an unmanaged later command',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'hiveward')
      const userInstallPath = join(userLocalBin, 'hiveward')
      const launcherPath = join(resourcesPath, 'bin', 'hiveward')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await writeFile(userInstallPath, '#!/usr/bin/env bash\necho other-hiveward\n', {
        encoding: 'utf8',
        mode: 0o755
      })

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${usrLocalBin}:${userLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(defaultInstallPath)
      expect(status.state).toBe('not_installed')

      const installed = await installer.install()
      expect(installed.commandPath).toBe(defaultInstallPath)
      expect(installed.state).toBe('installed')
      await expect(readlink(defaultInstallPath)).resolves.toBe(launcherPath)
      await expect(readFile(userInstallPath, 'utf8')).resolves.toContain('other-hiveward')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports a conflict for an unmanaged macOS hiveward that shadows the install path',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'hiveward')
      const userInstallPath = join(userLocalBin, 'hiveward')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await writeFile(userInstallPath, '#!/usr/bin/env bash\necho other-hiveward\n', {
        encoding: 'utf8',
        mode: 0o755
      })

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${userLocalBin}:${usrLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(userInstallPath)
      expect(status.state).toBe('conflict')
      await expect(installer.install()).rejects.toThrow('Refusing to replace non-HiveWard command')
      await expect(lstat(defaultInstallPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(userInstallPath, 'utf8')).resolves.toContain('other-hiveward')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'skips a non-executable unmanaged macOS hiveward before the install path',
    async () => {
      const fixture = await makeFixture()
      const homePath = join(fixture.root, 'home')
      const resourcesPath = await createPackagedMacLauncher(fixture.root)
      const usrLocalBin = join(fixture.root, 'usr', 'local', 'bin')
      const userLocalBin = join(homePath, '.local', 'bin')
      const defaultInstallPath = join(usrLocalBin, 'hiveward')
      const userInstallPath = join(userLocalBin, 'hiveward')
      const launcherPath = join(resourcesPath, 'bin', 'hiveward')
      await mkdir(usrLocalBin, { recursive: true })
      await mkdir(userLocalBin, { recursive: true })
      await writeFile(userInstallPath, '#!/usr/bin/env bash\necho other-hiveward\n', 'utf8')

      const installer = new CliInstaller({
        platform: 'darwin',
        isPackaged: true,
        resourcesPath,
        userDataPath: fixture.userDataPath,
        execPath: '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
        appPath: fixture.appPath,
        homePath,
        defaultMacCommandPath: defaultInstallPath,
        processPathEnv: `${userLocalBin}:${usrLocalBin}`
      })

      const status = await installer.getStatus()
      expect(status.commandPath).toBe(defaultInstallPath)
      expect(status.state).toBe('not_installed')

      const installed = await installer.install()
      expect(installed.commandPath).toBe(defaultInstallPath)
      expect(installed.state).toBe('installed')
      await expect(readlink(defaultInstallPath)).resolves.toBe(launcherPath)
      await expect(readFile(userInstallPath, 'utf8')).resolves.toContain('other-hiveward')
    }
  )

  // Why (#33872): HiveWard terminals put the bundled bin dir first on PATH, so registration linked the launcher to itself.
  describe.skipIf(process.platform === 'win32')('with the bundled launcher on PATH', () => {
    it('registers the default command instead of linking the launcher to itself', async () => {
      const { root, bundledBin, installerOptions, expectLauncherIntact } =
        await makeBundledLauncherFixture()
      const usrLocalBin = join(root, 'usr', 'local', 'bin')
      await mkdir(usrLocalBin, { recursive: true })

      const status = await new CliInstaller({
        ...installerOptions,
        defaultMacCommandPath: join(usrLocalBin, 'hiveward'),
        processPathEnv: [bundledBin, usrLocalBin].join(':')
      }).install()

      expect(status.state).toBe('installed')
      expect(status.commandPath).toBe(join(usrLocalBin, 'hiveward'))
      await expectLauncherIntact()
    })

    it('refuses a command path that reaches the launcher through an aliased directory', async () => {
      const { root, bundledBin, installerOptions, expectLauncherIntact } =
        await makeBundledLauncherFixture()
      const aliasBin = join(root, 'alias-bin')
      await symlink(bundledBin, aliasBin)

      const installer = new CliInstaller({
        ...installerOptions,
        commandPathOverride: join(aliasBin, 'hiveward')
      })

      await expect(installer.install()).rejects.toThrow('link to itself')
      await expectLauncherIntact()
    })

    it('still replaces a hard link to the launcher in another directory', async () => {
      const { root, bundledBin, installerOptions, expectLauncherIntact } =
        await makeBundledLauncherFixture()
      const usrLocalBin = join(root, 'usr', 'local', 'bin')
      await mkdir(usrLocalBin, { recursive: true })
      const hardLink = join(usrLocalBin, 'hiveward')
      await link(join(bundledBin, 'hiveward'), hardLink)

      const status = await new CliInstaller({
        ...installerOptions,
        commandPathOverride: hardLink
      }).install()

      expect(status.state).toBe('installed')
      expect((await lstat(hardLink)).isSymbolicLink()).toBe(true)
      await expectLauncherIntact()
    })
  })
})
