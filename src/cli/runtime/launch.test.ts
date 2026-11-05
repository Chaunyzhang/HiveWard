import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { headlessServeOzonePlatformSwitches } from '../../shared/headless-serve-ozone-platform'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import {
  getServeUpdateHandoffPath,
  parseServeUpdateHandoffState
} from '../../shared/serve-update-handoff'
import {
  readServeUpdateHandoff,
  SERVE_REPLACEMENT_READY_TIMEOUT_MS
} from './serve-update-supervisor'

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock
}))

import { launchHiveWardApp, serveHiveWardApp } from './launch'
import { getExecutableAppArgs, stripElectronRunAsNode } from './hiveward-app-executable'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn()
  unref = vi.fn()
  pid = 4101
}

const RECIPE_JSON = JSON.stringify({
  schemaVersion: 1,
  pairingCode: encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://sandbox.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  }),
  projectRoot: '/workspace/repo'
})
const SERVE_INSTALL_STATUS = '[serve] hiveward CLI install: installed'
const SSH_PRIVATE_KEY = 'TOP-SECRET-PRIVATE-KEY'
const SSH_AUTHORIZATION = 'Bearer TOP-SECRET-AUTHORIZATION'
const SSH_PASSPHRASE = 'TOP-SECRET-PASSPHRASE'
const SSH_COOKIE = 'session=TOP-SECRET-COOKIE'
const SSH_RECIPE_JSON = JSON.stringify({
  schemaVersion: 1,
  connection: {
    type: 'ssh',
    target: {
      label: 'Sandbox',
      host: 'sandbox.example.com',
      port: 22,
      username: 'root'
    },
    projectRoot: '/workspace/repo'
  },
  userData: {
    credentials: {
      privateKey: SSH_PRIVATE_KEY,
      authorization: SSH_AUTHORIZATION,
      passphrase: SSH_PASSPHRASE,
      cookie: SSH_COOKIE
    }
  }
})
const INVALID_SSH_RECIPE_JSON = SSH_RECIPE_JSON.replace('/workspace/repo', 'relative/repo')
const IGNORED_NON_RECIPE_STDOUT = '[serve] ignored non-recipe stdout'
const PROFILE = resolve('/profiles/serve')
const PIN_PROFILE = `--user-data-dir=${PROFILE}`
const HOST_SERVE_OZONE_SWITCHES = headlessServeOzonePlatformSwitches(process.platform)

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function firstServeSpawnArgs(): string[] {
  const args: unknown = spawnMock.mock.calls[0]?.[1]
  if (!Array.isArray(args)) {
    throw new Error('hiveward serve did not spawn its server')
  }
  return args.map(String)
}

function startRecipeJsonServer() {
  const child = new FakeChildProcess()
  spawnMock.mockReturnValue(child)
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const result = serveHiveWardApp({
    recipeJson: true,
    projectRoot: '/workspace/repo'
  })
  return { child, result, stdoutSpy, stderrSpy }
}

describe('serveHiveWardApp', () => {
  const temporaryDirectories: string[] = []

  beforeEach(() => {
    spawnMock.mockReset()
    spawnSyncMock.mockReset()
    process.env.HIVEWARD_APP_EXECUTABLE = '/Applications/HiveWard.app/Contents/MacOS/HiveWard'
    // Test Electron here; launch-serve-runtime.test.ts covers hivewardd selection.
    process.env.HIVEWARD_SERVE_RUNTIME = 'electron'
    process.env.HIVEWARD_USER_DATA_PATH = PROFILE
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.HIVEWARD_SERVE_RUNTIME
    delete process.env.HIVEWARD_APP_EXECUTABLE
    delete process.env.HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT
    delete process.env.HIVEWARD_USER_DATA_PATH
    return Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
    )
  })

  it('names what to run when this hiveward is not an HiveWard app (an SSH host server CLI)', () => {
    delete process.env.HIVEWARD_APP_EXECUTABLE
    const previous = process.env.ELECTRON_RUN_AS_NODE
    delete process.env.ELECTRON_RUN_AS_NODE
    try {
      expect(() => serveHiveWardApp({ supervise: true })).toThrow(
        /Install the HiveWard app on this machine/
      )
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      restoreEnv('ELECTRON_RUN_AS_NODE', previous)
    }
  })

  it('launches an isolated profile with the keychain mocked, so serve is not blocked on it', async () => {
    const previousUserData = process.env.HIVEWARD_E2E_USER_DATA_DIR
    const previousHome = process.env.HIVEWARD_E2E_HOME_DIR
    process.env.HIVEWARD_E2E_USER_DATA_DIR = '/tmp/hiveward-e2e-profile'
    try {
      const { child, result } = startRecipeJsonServer()
      queueMicrotask(() => child.stdout.emit('data', `${RECIPE_JSON}\n`))
      await expect(result).resolves.toBe(0)

      const args = firstServeSpawnArgs()
      expect(args).toEqual(
        expect.arrayContaining(['--password-store=basic', '--use-mock-keychain'])
      )
    } finally {
      restoreEnv('HIVEWARD_E2E_USER_DATA_DIR', previousUserData)
      restoreEnv('HIVEWARD_E2E_HOME_DIR', previousHome)
    }
  })

  it('keeps the real keychain when only HOME is overridden', async () => {
    const previousUserData = process.env.HIVEWARD_E2E_USER_DATA_DIR
    const previousHome = process.env.HIVEWARD_E2E_HOME_DIR
    delete process.env.HIVEWARD_E2E_USER_DATA_DIR
    process.env.HIVEWARD_E2E_HOME_DIR = '/tmp/hiveward-e2e-home-only'
    try {
      const { child, result } = startRecipeJsonServer()
      queueMicrotask(() => child.stdout.emit('data', `${RECIPE_JSON}\n`))
      await expect(result).resolves.toBe(0)

      const args = firstServeSpawnArgs()
      expect(args).not.toContain('--use-mock-keychain')
      expect(args).not.toContain('--password-store=basic')
    } finally {
      restoreEnv('HIVEWARD_E2E_USER_DATA_DIR', previousUserData)
      restoreEnv('HIVEWARD_E2E_HOME_DIR', previousHome)
    }
  })

  it('leaves a normal profile on the real keychain', async () => {
    const previousUserData = process.env.HIVEWARD_E2E_USER_DATA_DIR
    const previousHome = process.env.HIVEWARD_E2E_HOME_DIR
    delete process.env.HIVEWARD_E2E_USER_DATA_DIR
    delete process.env.HIVEWARD_E2E_HOME_DIR
    try {
      const { child, result } = startRecipeJsonServer()
      queueMicrotask(() => child.stdout.emit('data', `${RECIPE_JSON}\n`))
      await expect(result).resolves.toBe(0)

      const args = firstServeSpawnArgs()
      expect(args).not.toContain('--use-mock-keychain')
      expect(args).not.toContain('--password-store=basic')
    } finally {
      restoreEnv('HIVEWARD_E2E_USER_DATA_DIR', previousUserData)
      restoreEnv('HIVEWARD_E2E_HOME_DIR', previousHome)
    }
  })

  it.runIf(process.platform === 'darwin')(
    'keeps the serve supervisor alive until the installed target version can take ownership',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hiveward-serve-update-'))
      temporaryDirectories.push(root)
      const appPath = join(root, 'HiveWard.app')
      const executable = join(appPath, 'Contents', 'MacOS', 'HiveWard')
      const infoPlistPath = join(appPath, 'Contents', 'Info.plist')
      const userDataPath = join(root, 'user-data')
      await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true })
      await mkdir(userDataPath, { recursive: true })
      await writeFile(
        infoPlistPath,
        '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.51</string></dict></plist>'
      )
      process.env.HIVEWARD_APP_EXECUTABLE = executable
      process.env.HIVEWARD_USER_DATA_PATH = userDataPath

      const oldOwner = new FakeChildProcess()
      const replacementOwner = new FakeChildProcess()
      replacementOwner.pid = 4102
      spawnMock.mockReturnValueOnce(oldOwner).mockReturnValueOnce(replacementOwner)
      let supervisorExited = false
      const supervisor = serveHiveWardApp({ json: true }).then((code) => {
        supervisorExited = true
        return code
      })
      const childEnv = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv | undefined
      const handoffPath = childEnv?.HIVEWARD_SERVE_UPDATE_HANDOFF_PATH
      expect(handoffPath).toBeTruthy()
      await writeFile(
        handoffPath!,
        JSON.stringify({
          schemaVersion: 1,
          phase: 'install-requested',
          fromVersion: '1.0.51',
          targetVersion: '1.0.61',
          servingPid: oldOwner.pid
        })
      )

      oldOwner.emit('exit', 0, null)
      await Promise.resolve()

      expect(supervisorExited).toBe(false)
      expect(spawnMock).toHaveBeenCalledTimes(1)

      const updateAppPath = join(root, 'Update.app')
      await mkdir(join(updateAppPath, 'Contents'), { recursive: true })
      await writeFile(
        join(updateAppPath, 'Contents', 'Info.plist'),
        '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.61</string></dict></plist>'
      )
      await rename(appPath, join(root, 'Previous.app'))
      await rename(updateAppPath, appPath)
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      replacementOwner.emit('message', {
        type: 'hiveward:serve-ready',
        version: '1.0.61',
        runtimeId: 'runtime-new'
      })

      expect(supervisorExited).toBe(false)
      await vi.waitFor(async () => expect(await readServeUpdateHandoff(handoffPath!)).toBeNull())
      replacementOwner.emit('exit', 0, null)
      await expect(supervisor).resolves.toBe(0)
    }
  )

  it.runIf(process.platform === 'darwin')(
    'records a replacement version mismatch without starting a retry loop',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hiveward-serve-update-mismatch-'))
      temporaryDirectories.push(root)
      const appPath = join(root, 'HiveWard.app')
      const executable = join(appPath, 'Contents', 'MacOS', 'HiveWard')
      const userDataPath = join(root, 'user-data')
      await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true })
      await mkdir(userDataPath, { recursive: true })
      await writeFile(
        join(appPath, 'Contents', 'Info.plist'),
        '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.61</string></dict></plist>'
      )
      const handoffPath = getServeUpdateHandoffPath(userDataPath)
      await writeFile(
        handoffPath,
        JSON.stringify({
          schemaVersion: 1,
          phase: 'install-requested',
          fromVersion: '1.0.51',
          targetVersion: '1.0.61',
          servingPid: 4101
        })
      )
      process.env.HIVEWARD_APP_EXECUTABLE = executable
      process.env.HIVEWARD_USER_DATA_PATH = userDataPath
      const replacementOwner = new FakeChildProcess()
      replacementOwner.pid = 4102
      spawnMock.mockReturnValue(replacementOwner)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      const supervisor = serveHiveWardApp({ json: true })
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
      replacementOwner.emit('message', {
        type: 'hiveward:serve-ready',
        version: '1.0.51',
        runtimeId: 'runtime-old'
      })
      await vi.waitFor(() => expect(replacementOwner.kill).toHaveBeenCalledWith('SIGTERM'))
      replacementOwner.emit('exit', 0, null)

      await expect(supervisor).resolves.toBe(1)
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(parseServeUpdateHandoffState(JSON.parse(await readFile(handoffPath, 'utf8')))).toEqual(
        expect.objectContaining({
          phase: 'failed',
          targetVersion: '1.0.61',
          reason: expect.stringContaining('reported version 1.0.51')
        })
      )
    }
  )

  it.runIf(process.platform === 'darwin')(
    'records replacement spawn failure before rejecting without a retry loop',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hiveward-serve-update-spawn-failure-'))
      temporaryDirectories.push(root)
      const appPath = join(root, 'HiveWard.app')
      const executable = join(appPath, 'Contents', 'MacOS', 'HiveWard')
      const userDataPath = join(root, 'user-data')
      await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true })
      await mkdir(userDataPath, { recursive: true })
      await writeFile(
        join(appPath, 'Contents', 'Info.plist'),
        '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.61</string></dict></plist>'
      )
      const handoffPath = getServeUpdateHandoffPath(userDataPath)
      await writeFile(
        handoffPath,
        JSON.stringify({
          schemaVersion: 1,
          phase: 'install-requested',
          fromVersion: '1.0.51',
          targetVersion: '1.0.61',
          servingPid: 4101
        })
      )
      process.env.HIVEWARD_APP_EXECUTABLE = executable
      process.env.HIVEWARD_USER_DATA_PATH = userDataPath
      const replacementOwner = new FakeChildProcess()
      spawnMock.mockReturnValue(replacementOwner)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      const supervisor = serveHiveWardApp({ json: true })
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
      replacementOwner.emit('error', new Error('spawn ENOENT'))

      await expect(supervisor).rejects.toThrow('spawn ENOENT')
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(parseServeUpdateHandoffState(JSON.parse(await readFile(handoffPath, 'utf8')))).toEqual(
        expect.objectContaining({
          phase: 'failed',
          targetVersion: '1.0.61',
          reason: expect.stringContaining('spawn ENOENT')
        })
      )
    }
  )

  it.runIf(process.platform === 'darwin')(
    'fails a replacement that never reports runtime readiness without retrying it',
    async () => {
      vi.useFakeTimers()
      const root = await mkdtemp(join(tmpdir(), 'hiveward-serve-update-no-readiness-'))
      temporaryDirectories.push(root)
      const appPath = join(root, 'HiveWard.app')
      const executable = join(appPath, 'Contents', 'MacOS', 'HiveWard')
      const userDataPath = join(root, 'user-data')
      await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true })
      await mkdir(userDataPath, { recursive: true })
      await writeFile(
        join(appPath, 'Contents', 'Info.plist'),
        '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.61</string></dict></plist>'
      )
      const handoffPath = getServeUpdateHandoffPath(userDataPath)
      await writeFile(
        handoffPath,
        JSON.stringify({
          schemaVersion: 1,
          phase: 'install-requested',
          fromVersion: '1.0.51',
          targetVersion: '1.0.61',
          servingPid: 4101
        })
      )
      process.env.HIVEWARD_APP_EXECUTABLE = executable
      process.env.HIVEWARD_USER_DATA_PATH = userDataPath
      const replacementOwner = new FakeChildProcess()
      spawnMock.mockReturnValue(replacementOwner)
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      try {
        const supervisor = serveHiveWardApp({ json: true })
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())

        await vi.advanceTimersByTimeAsync(SERVE_REPLACEMENT_READY_TIMEOUT_MS)
        expect(replacementOwner.kill).toHaveBeenCalledWith('SIGTERM')
        replacementOwner.emit('exit', 0, null)

        await expect(supervisor).resolves.toBe(1)
        expect(spawnMock).toHaveBeenCalledOnce()
        expect(
          parseServeUpdateHandoffState(JSON.parse(await readFile(handoffPath, 'utf8')))
        ).toEqual(
          expect.objectContaining({
            phase: 'failed',
            reason: expect.stringContaining('did not report serving version')
          })
        )
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('pins the Electron child cwd to the app root instead of the caller cwd', async () => {
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(serveHiveWardApp({ json: true })).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
      [PIN_PROFILE, '--serve', '--serve-json', ...HOST_SERVE_OZONE_SWITCHES],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('passes mobile pairing through to the foreground server child', async () => {
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(
      serveHiveWardApp({
        json: true,
        port: '6768',
        pairingAddress: '100.64.1.20',
        mobilePairing: true
      })
    ).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
      [
        PIN_PROFILE,
        '--serve',
        '--serve-json',
        '--serve-port',
        '6768',
        '--serve-pairing-address',
        '100.64.1.20',
        '--serve-mobile-pairing',
        ...HOST_SERVE_OZONE_SWITCHES
      ],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('passes the app root before serve flags for dev Electron executables', async () => {
    process.env.HIVEWARD_APP_EXECUTABLE = '/repo/node_modules/.bin/electron'
    process.env.HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT = '1'
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(serveHiveWardApp({ json: true, port: '6768' })).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/repo/node_modules/.bin/electron',
      [
        resolve(__dirname, '../../..'),
        PIN_PROFILE,
        '--serve',
        '--serve-json',
        '--serve-port',
        '6768',
        ...HOST_SERVE_OZONE_SWITCHES
      ],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it("re-applies a direct launch's --no-sandbox to the Electron it starts, not to terminals", () => {
    process.env.HIVEWARD_ELECTRON_NO_SANDBOX = '1'
    try {
      expect(getExecutableAppArgs('/opt/HiveWard/hiveward')).toEqual(['--no-sandbox'])
      expect(stripElectronRunAsNode(process.env)).not.toHaveProperty('HIVEWARD_ELECTRON_NO_SANDBOX')
    } finally {
      delete process.env.HIVEWARD_ELECTRON_NO_SANDBOX
    }
  })

  it.each([
    { probe: 'exits nonzero', result: { status: 1 }, expectedPrefix: ['--no-sandbox'] },
    { probe: 'succeeds', result: { status: 0 }, expectedPrefix: [] },
    {
      probe: 'times out',
      result: {
        status: null,
        error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
      },
      expectedPrefix: ['--no-sandbox']
    },
    {
      probe: 'cannot start',
      result: { status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) },
      expectedPrefix: ['--no-sandbox']
    }
  ])(
    'uses the extracted AppImage sandbox fallback when the userns probe $probe',
    async ({ result: userNamespaceResult, expectedPrefix }) => {
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
      const getuidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid')
      const root = await mkdtemp(join(tmpdir(), 'hiveward-extracted-appimage-'))
      temporaryDirectories.push(root)
      const executable = join(root, 'hiveward')
      await writeFile(join(root, 'AppRun'), '', { mode: 0o755 })
      process.env.HIVEWARD_APP_EXECUTABLE = executable
      Object.defineProperty(process, 'platform', { value: 'linux' })
      Object.defineProperty(process, 'getuid', { configurable: true, value: () => 1000 })
      spawnSyncMock.mockReturnValue(userNamespaceResult)
      const child = new FakeChildProcess()
      spawnMock.mockReturnValue(child)

      try {
        const result = serveHiveWardApp({ json: true })
        queueMicrotask(() => child.emit('exit', 0, null))
        await expect(result).resolves.toBe(0)
        expect(spawnSyncMock).toHaveBeenCalledWith(
          'unshare',
          ['-Ur', 'true'],
          expect.objectContaining({ stdio: 'ignore', timeout: 2_000 })
        )
        expect(spawnMock).toHaveBeenCalledWith(
          executable,
          [...expectedPrefix, PIN_PROFILE, '--serve', '--serve-json', '--ozone-platform=x11'],
          // Foreground serve must share POSIX job-control signals with its CLI supervisor.
          expect.objectContaining({ detached: false })
        )
      } finally {
        if (platformDescriptor) {
          Object.defineProperty(process, 'platform', platformDescriptor)
        }
        if (getuidDescriptor) {
          Object.defineProperty(process, 'getuid', getuidDescriptor)
        } else {
          Reflect.deleteProperty(process, 'getuid')
        }
      }
    }
  )

  it('prints recipe JSON from a detached server child and exits', async () => {
    const child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const result = serveHiveWardApp({
      pairingAddress: 'wss://sandbox.example.com',
      recipeJson: true,
      projectRoot: '/workspace/repo'
    })
    queueMicrotask(() => {
      child.stdout.emit('data', `${RECIPE_JSON}\n`)
    })

    await expect(result).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
      [
        PIN_PROFILE,
        '--serve',
        '--serve-pairing-address',
        'wss://sandbox.example.com',
        '--serve-recipe-json',
        '--serve-project-root',
        '/workspace/repo',
        ...HOST_SERVE_OZONE_SWITCHES
      ],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..'),
        detached: true,
        stdio: ['ignore', 'pipe', 'inherit']
      })
    )
    expect(writeSpy).toHaveBeenCalledWith(`${RECIPE_JSON}\n`)
    expect(child.unref).toHaveBeenCalled()
  })

  it('waits past startup status lines for valid recipe JSON', async () => {
    const { child, result, stdoutSpy, stderrSpy } = startRecipeJsonServer()
    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        `${SERVE_INSTALL_STATUS}\n${INVALID_SSH_RECIPE_JSON}\n${SSH_RECIPE_JSON}\n${RECIPE_JSON.slice(0, 40)}`
      )
      child.stdout.emit('data', `${RECIPE_JSON.slice(40)}\n`)
    })

    await expect(result).resolves.toBe(0)

    expect(stderrSpy).toHaveBeenNthCalledWith(1, `${IGNORED_NON_RECIPE_STDOUT}\n`)
    expect(stderrSpy).toHaveBeenNthCalledWith(2, `${IGNORED_NON_RECIPE_STDOUT}\n`)
    expect(stderrSpy).toHaveBeenNthCalledWith(3, `${IGNORED_NON_RECIPE_STDOUT}\n`)
    for (const secret of [SSH_PRIVATE_KEY, SSH_AUTHORIZATION, SSH_PASSPHRASE, SSH_COOKIE]) {
      expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining(secret))
    }
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    expect(stdoutSpy).toHaveBeenCalledWith(`${RECIPE_JSON}\n`)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('preserves UTF-8 recipe JSON split across Buffer chunks', async () => {
    const { child, result, stdoutSpy } = startRecipeJsonServer()
    const unicodeRecipeJson = RECIPE_JSON.replace('/workspace/repo', '/workspace/café')
    const recipeBuffer = Buffer.from(`${unicodeRecipeJson}\n`)
    const splitIndex = recipeBuffer.indexOf(Buffer.from('é')) + 1
    queueMicrotask(() => {
      child.stdout.emit('data', recipeBuffer.subarray(0, splitIndex))
      child.stdout.emit('data', recipeBuffer.subarray(splitIndex))
    })

    await expect(result).resolves.toBe(0)

    expect(stdoutSpy).toHaveBeenCalledWith(`${unicodeRecipeJson}\n`)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('rejects when the server exits without valid recipe JSON', async () => {
    const { child, result, stdoutSpy, stderrSpy } = startRecipeJsonServer()
    const secrets = ['UPPER-SECRET', 'SLASH-SECRET', 'LEGACY-SECRET', 'PRIVATE-SECRET']
    const untrustedLines = [
      'HIVEWARD://pair?code=UPPER-SECRET',
      'hiveward://pair/?code=SLASH-SECRET',
      'hiveward://pair#LEGACY-SECRET',
      '"embedded privateKey PRIVATE-SECRET"',
      '{privateKey:"PRIVATE-SECRET"}'
    ].join('\n')
    queueMicrotask(() => {
      child.stdout.emit('data', `${untrustedLines}\n`)
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
    })

    await expect(result).rejects.toMatchObject({
      code: 'runtime_serve_failed',
      message: 'HiveWard serve exited before printing valid recipe JSON with code 0.'
    })
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(stderrSpy).toHaveBeenCalledTimes(5)
    expect(stderrSpy).toHaveBeenCalledWith(`${IGNORED_NON_RECIPE_STDOUT}\n`)
    for (const secret of secrets) {
      expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining(secret))
    }
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('accepts valid recipe JSON at exit without a trailing newline', async () => {
    const { child, result, stdoutSpy } = startRecipeJsonServer()
    queueMicrotask(() => {
      child.emit('exit', 0, null)
      child.stdout.emit('data', RECIPE_JSON)
      child.emit('close', 0, null)
    })

    await expect(result).resolves.toBe(0)

    expect(stdoutSpy).toHaveBeenCalledWith(`${RECIPE_JSON}\n`)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('runs a Windows command-shim Electron executable through cmd.exe without a raw shell', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.HIVEWARD_APP_EXECUTABLE = 'C:\\repo\\node_modules\\.bin\\electron.cmd'
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    try {
      await expect(serveHiveWardApp({ json: true })).resolves.toBe(0)
      const [program, [commandLine], options] = spawnMock.mock.calls[0]
      expect(program).toMatch(/cmd\.exe$/i)
      expect(commandLine).toContain('C:\\repo\\node_modules\\.bin\\electron.cmd')
      expect(commandLine).toContain('--serve-json')
      expect(options).toEqual(
        expect.objectContaining({ shell: false, windowsHide: true, windowsVerbatimArguments: true })
      )
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
    }
  })
})

describe('launchHiveWardApp', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnSyncMock.mockReset()
    process.env.HIVEWARD_USER_DATA_PATH = PROFILE
  })

  afterEach(() => {
    delete process.env.HIVEWARD_USER_DATA_PATH
    delete process.env.HIVEWARD_OPEN_COMMAND
    delete process.env.HIVEWARD_APP_EXECUTABLE
    delete process.env.HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT
  })

  it('handles asynchronous detached spawn errors without throwing', async () => {
    process.env.HIVEWARD_APP_EXECUTABLE = '/missing/HiveWard'
    const child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)

    launchHiveWardApp()
    child.emit('error', new Error('ENOENT'))
    await Promise.resolve()

    expect(child.unref).toHaveBeenCalled()
  })

  it('adds the extracted-AppImage sandbox fallback for open launches', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid')
    const root = await mkdtemp(join(tmpdir(), 'hiveward-open-extracted-appimage-'))
    const executable = join(root, 'hiveward')

    try {
      await writeFile(join(root, 'AppRun'), '')
      process.env.HIVEWARD_APP_EXECUTABLE = executable
      process.env.ELECTRON_RUN_AS_NODE = '1'
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      Object.defineProperty(process, 'getuid', { configurable: true, value: () => 1000 })
      spawnSyncMock.mockReturnValue({ status: 1 })
      const child = new FakeChildProcess()
      spawnMock.mockReturnValue(child)

      launchHiveWardApp()

      expect(spawnSyncMock).toHaveBeenCalledWith(
        'unshare',
        ['-Ur', 'true'],
        expect.objectContaining({ stdio: 'ignore', timeout: 2_000 })
      )
      expect(spawnMock).toHaveBeenCalledWith(
        executable,
        ['--no-sandbox', PIN_PROFILE],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
          env: expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: '1' })
        })
      )
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
      delete process.env.ELECTRON_RUN_AS_NODE
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
      if (getuidDescriptor) {
        Object.defineProperty(process, 'getuid', getuidDescriptor)
      } else {
        Reflect.deleteProperty(process, 'getuid')
      }
    }
  })
})
