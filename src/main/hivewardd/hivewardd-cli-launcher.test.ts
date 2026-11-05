import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@hiveward/process-host'
import {
  HIVEWARDD_CLI_ENTRY_FILENAME,
  HIVEWARDD_WINDOWS_CLI_LAUNCHER_FILENAME
} from '../../shared/hivewardd-artifacts'
import {
  HIVEWARDD_WINDOWS_CLI_LAUNCHER_CONFIG_FILENAME,
  getHivewarddCliLauncherPath,
  prepareHivewarddCliLauncher
} from './hivewardd-cli-launcher'

const roots = vi.hoisted(() => ({ install: '', profile: '' }))
vi.mock('./hivewardd-app-paths', () => ({
  resolveHivewarddInstallRoot: () => roots.install,
  resolveUserDataPath: () => roots.profile
}))

let directory = ''
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hiveward-node-cli-'))
  roots.install = join(directory, "server ' slot")
  roots.profile = join(directory, "profile ' data")
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  await rm(directory, { recursive: true, force: true })
})

async function writeCli(): Promise<void> {
  const path = join(roots.install, ...HIVEWARDD_CLI_ENTRY_FILENAME.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    'console.log(JSON.stringify({profile:process.env.HIVEWARD_USER_DATA_PATH, args:process.argv.slice(2), electron:process.env.ELECTRON_RUN_AS_NODE}))'
  )
}

describe('hivewardd profile CLI launcher', () => {
  it.skipIf(process.platform === 'win32')(
    'launches pinned Node with intact arguments and the execution host profile',
    async () => {
      await writeCli()
      await prepareHivewarddCliLauncher()
      const launcher = getHivewarddCliLauncherPath()
      expect(launcher).toBe(join(roots.profile, 'cli', 'bin', 'hiveward'))
      if (!launcher) {
        throw new Error('CLI launcher is missing')
      }
      const args = ['orchestration', 'send', 'a body\nwith "quotes" and $HOME']
      const launchers = [launcher]
      for (const program of launchers) {
        const result = await runProcess({
          program,
          args,
          env: {
            ...process.env,
            HIVEWARD_USER_DATA_PATH: '/another/owner',
            ELECTRON_RUN_AS_NODE: '1',
            NODE_OPTIONS: '--require /missing/inherited/preload'
          },
          timeoutMs: 5000
        })
        expect(result.code).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({ profile: roots.profile, args })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    "passes a person's own HiveWard settings through, adding only the profile",
    async () => {
      const path = join(roots.install, ...HIVEWARDD_CLI_ENTRY_FILENAME.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        "console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('HIVEWARD_')))))"
      )
      await prepareHivewarddCliLauncher()
      const result = await runProcess({
        program: getHivewarddCliLauncherPath()!,
        args: ['status'],
        env: {
          PATH: process.env.PATH,
          HIVEWARD_ENVIRONMENT: 'other-server',
          HIVEWARD_PAIRING_CODE: 'other-pairing'
        },
        timeoutMs: 5000
      })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        HIVEWARD_USER_DATA_PATH: roots.profile,
        HIVEWARD_ENVIRONMENT: 'other-server',
        HIVEWARD_PAIRING_CODE: 'other-pairing'
      })
    }
  )

  it('leaves old slots without a CLI usable and clears a previous launcher', async () => {
    await writeCli()
    await prepareHivewarddCliLauncher()
    roots.install = join(directory, 'old server')
    await prepareHivewarddCliLauncher()
    expect(getHivewarddCliLauncherPath()).toBeNull()
  })

  describe('on a Windows host', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    })

    async function writeLauncher(contents: string): Promise<void> {
      const path = join(roots.install, ...HIVEWARDD_WINDOWS_CLI_LAUNCHER_FILENAME.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, contents)
    }

    const binDir = (): string => join(roots.profile, 'cli', 'bin')
    const readConfig = (): Promise<string> =>
      readFile(join(binDir(), HIVEWARDD_WINDOWS_CLI_LAUNCHER_CONFIG_FILENAME), 'utf8')

    it('installs the native launcher and points it at this slot, runtime and profile', async () => {
      await writeCli()
      await writeLauncher('native launcher v1')
      await prepareHivewarddCliLauncher()
      const launcher = getHivewarddCliLauncherPath()
      expect(launcher).toBe(join(binDir(), 'hiveward.exe'))
      expect(await readFile(launcher!, 'utf8')).toBe('native launcher v1')
      expect(await readConfig()).toBe(
        [
          `node=${process.execPath}`,
          `cli=${join(roots.install, ...HIVEWARDD_CLI_ENTRY_FILENAME.split('/'))}`,
          `user-data=${roots.profile}`,
          ''
        ].join('\n')
      )
      // Batch/PowerShell proxies can reparse cmd.exe arguments instead of preserving them.
      expect((await readdir(binDir())).sort()).toEqual(
        [HIVEWARDD_WINDOWS_CLI_LAUNCHER_CONFIG_FILENAME, 'hiveward.exe'].sort()
      )
    })

    it('refreshes the launcher and its target when the host switches server slots', async () => {
      await writeCli()
      await writeLauncher('native launcher v1')
      await prepareHivewarddCliLauncher()
      roots.install = join(directory, 'updated server')
      await writeCli()
      await writeLauncher('native launcher v2')
      await prepareHivewarddCliLauncher()
      expect(await readFile(join(binDir(), 'hiveward.exe'), 'utf8')).toBe('native launcher v2')
      expect(await readConfig()).toContain(`cli=${join(roots.install, 'out', 'cli', 'index.js')}`)
    })
  })
})
