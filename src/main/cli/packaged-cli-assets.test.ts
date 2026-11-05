import { copyHiveWardRuntimeModules } from '../../../config/scripts/build-cli.mjs'
import { execFile, spawn } from 'node:child_process'
import { globSync } from 'node:fs'
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createPackageWithOptions, statFile } from '@electron/asar'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@hiveward/process-host'
import { stagePackagedProcessHost } from '../../../config/scripts/packaged-process-host-fixture.mjs'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const itRunsUnixShell = process.platform === 'win32' ? it.skip : it
const unixTerminationSignals = ['SIGINT', 'SIGTERM'] as const
const builderConfig = require('../../../config/electron-builder.config.cjs') as {
  files?: string[]
  asarUnpack?: string[]
}
const linuxLauncherAsset = new URL('../../../resources/linux/engine/hiwd-engine', import.meta.url)
const darwinLauncherAsset = new URL('../../../resources/darwin/engine/hiwd-engine', import.meta.url)
const linuxEngine = {
  appDir: ['HiveWard'],
  executable: ['hiveward'],
  cli: ['resources', 'app.asar.unpacked', 'out', 'cli', 'index.js']
} as const
const darwinEngine = {
  appDir: ['HiveWard.app'],
  executable: ['Contents', 'MacOS', 'HiveWard'],
  cli: ['Contents', 'Resources', 'app.asar.unpacked', 'out', 'cli', 'index.js']
} as const
// hiwd / hiveward on PATH run hiwd.mjs, which forwards unknown commands to the off-PATH engine launcher.
const unixLauncherFixtures = [
  {
    name: 'Linux engine',
    asset: linuxLauncherAsset,
    launcher: ['resources', 'engine', 'hiwd-engine'],
    ...linuxEngine
  },
  {
    name: 'macOS engine',
    asset: darwinLauncherAsset,
    launcher: ['Contents', 'Resources', 'engine', 'hiwd-engine'],
    ...darwinEngine
  },
  ...(['hiwd', 'hiveward'] as const).flatMap((name) => [
    {
      name: `Linux ${name}`,
      asset: new URL(`../../../resources/linux/bin/${name}`, import.meta.url),
      launcher: ['resources', 'bin', name],
      ...linuxEngine,
      cli: ['resources', 'hiveward', 'server', 'hiwd.mjs']
    },
    {
      name: `macOS ${name}`,
      asset: new URL(`../../../resources/darwin/bin/${name}`, import.meta.url),
      launcher: ['Contents', 'Resources', 'bin', name],
      ...darwinEngine,
      cli: ['Contents', 'Resources', 'hiveward', 'server', 'hiwd.mjs']
    }
  ])
] as const

describe('packaged CLI assets', () => {
  it('loads worktree link validation from the installed CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hiveward-cli-gitlab-package-'))
    const projectDir = fileURLToPath(new URL('../../../', import.meta.url))
    const source = join(root, 'app-source')
    const archive = join(root, 'resources', 'app.asar')
    try {
      const compile = await runProcess({
        program: process.execPath,
        args: [
          join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc'),
          '-p',
          join(projectDir, 'config', 'tsconfig.build.cli.json'),
          '--outDir',
          join(source, 'out'),
          '--composite',
          'false',
          '--incremental',
          'false',
          // This fixture checks the emitted package; the CLI typecheck runs separately.
          '--noCheck'
        ],
        cwd: projectDir,
        timeoutMs: 60_000
      })
      expect(compile.code, compile.stdout + compile.stderr).toBe(0)
      copyHiveWardRuntimeModules(projectDir,join(source,'out'))
      expect(globSync('**/*.{test,spec}.{js,jsx,cjs,mjs}', { cwd: join(source, 'out') })).toEqual(
        []
      )
      await mkdir(dirname(archive), { recursive: true })
      await writeFile(join(source, 'out', 'package.json'), JSON.stringify({ type: 'commonjs' }))
      for (const name of ['zod', 'tweetnacl']) {
        await cp(
          join(projectDir, 'node_modules', name),
          join(root, 'resources', 'node_modules', name),
          {
            recursive: true,
            dereference: true
          }
        )
      }
      await stagePackagedProcessHost(join(root, 'resources'))
      await createPackageWithOptions(source, archive, {
        unpack: `{${builderConfig.asarUnpack?.map((pattern) => join(source, pattern).split(sep).join('/')).join(',')}}`
      })
      expect(statFile(archive, join('out', 'cli', 'index.js')).unpacked).toBe(true)
      const result = await runProcess({
        program: process.execPath,
        args: [
          join(`${archive}.unpacked`, 'out', 'cli', 'index.js'),
          'worktree',
          'create',
          '--repo',
          'id:repo',
          '--name',
          'packaged-link',
          '--no-parent',
          '--pr',
          '0',
          '--json'
        ],
        cwd: root,
        env: {
          ...process.env,
          HIVEWARD_BACKGROUND_LAUNCH: '1',
          NODE_PATH: '',
          NODE_OPTIONS: '',
          HIVEWARD_USER_DATA_PATH: join(root, 'user-data'),
          HOME: join(root, 'home')
        },
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument', message: 'Pass a positive safe integer for --pr.' }
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  itRunsUnixShell.each(unixLauncherFixtures)(
    'delivers Unix termination signals to the $name executable and releases its listener',
    async (launcherFixture) => {
      for (const signal of unixTerminationSignals) {
        const root = await mkdtemp(join(tmpdir(), 'hiveward-unix-cli-signal-'))
        const appDir = join(root, ...launcherFixture.appDir)
        const launcherPath = join(appDir, ...launcherFixture.launcher)
        const electronPath = join(appDir, ...launcherFixture.executable)
        const cliPath = join(appDir, ...launcherFixture.cli)
        const statePath = join(root, `${signal}-listener-state.json`)
        let executablePid: number | null = null
        let launcher: ReturnType<typeof spawn> | null = null
        try {
          await mkdir(dirname(launcherPath), { recursive: true })
          await mkdir(dirname(electronPath), { recursive: true })
          await mkdir(dirname(cliPath), { recursive: true })
          await copyFile(launcherFixture.asset, launcherPath)
          await writeFile(cliPath, '', 'utf8')
          await writeFile(
            electronPath,
            `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')
const server = net.createServer()
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.HIVEWARD_TEST_LISTENER_STATE, JSON.stringify({
    pid: process.pid,
    port: server.address().port
  }))
})
`,
            { encoding: 'utf8', mode: 0o755 }
          )

          launcher = spawn(launcherPath, [], {
            env: { ...process.env, HIVEWARD_TEST_LISTENER_STATE: statePath },
            stdio: 'ignore'
          })
          const state = await waitForListenerState(statePath)
          executablePid = state.pid
          const launcherPid = launcher.pid
          const launcherExitPromise = waitForChildExit(launcher, 5_000)
          launcher.kill(signal)
          const launcherExit = await launcherExitPromise
          const exitCode = launcherExit?.[0]
          const exitSignal = launcherExit?.[1]

          expect.soft(executablePid).toBe(launcherPid)
          expect.soft(launcherExit).not.toBeNull()
          expect.soft(exitCode).toBe(0)
          expect.soft(exitSignal).toBeNull()
          expect.soft(await waitForPortRelease(state.port)).toBe(true)
        } finally {
          if (launcher?.pid) {
            await terminateSyntheticProcess(launcher.pid)
          }
          if (executablePid && executablePid !== launcher?.pid) {
            await terminateSyntheticProcess(executablePid)
          }
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  )

  itRunsUnixShell(
    'runs the Linux launcher from its packaged path and installed symlink',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hiveward-linux-cli-'))
      try {
        const appDir = join(root, 'HiveWard')
        const resourcesDir = join(appDir, 'resources')
        const launcherDir = join(resourcesDir, 'engine')
        const cliDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'cli')
        const launcherPath = join(launcherDir, 'hiwd-engine')
        const electronPath = join(appDir, 'hiveward')
        const cliPath = join(cliDir, 'index.js')

        await mkdir(launcherDir, { recursive: true })
        await mkdir(cliDir, { recursive: true })
        await copyFile(linuxLauncherAsset, launcherPath)
        expect((await stat(launcherPath)).mode & 0o111).not.toBe(0)
        await writeFile(cliPath, '', 'utf8')
        await writeFile(
          electronPath,
          `#!/usr/bin/env bash
printf 'electron=%s\\n' "$0"
printf 'run_as_node=%s\\n' "\${ELECTRON_RUN_AS_NODE-}"
printf 'arg=%s\\n' "$@"
`,
          { encoding: 'utf8', mode: 0o755 }
        )

        const direct = await execFileAsync(launcherPath, ['--help'])
        expect(direct.stdout).toContain(`electron=${electronPath}`)
        expect(direct.stdout).toContain('run_as_node=1')
        expect(direct.stdout).toContain(`arg=${cliPath}`)
        expect(direct.stdout).toContain('arg=--help')

        const homeDir = join(root, 'home')
        const commandDir = join(homeDir, '.local', 'bin')
        const commandPath = join(commandDir, 'hiveward')
        await mkdir(commandDir, { recursive: true })
        await mkdir(join(homeDir, 'hiveward'), { recursive: true })
        await symlink(launcherPath, commandPath)

        const symlinked = await execFileAsync(commandPath, ['--help'], {
          env: { ...process.env, HOME: homeDir }
        })
        expect(symlinked.stdout).toContain(`electron=${electronPath}`)
        expect(symlinked.stdout).toContain('run_as_node=1')
        expect(symlinked.stdout).toContain(`arg=${cliPath}`)
        expect(symlinked.stdout).toContain('arg=--help')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  itRunsUnixShell.each(unixLauncherFixtures)(
    'sanitizes node env and forwards argv verbatim through the $name launcher',
    async (launcherFixture) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'hiveward-unix-cli-env-')))
      try {
        const appDir = join(root, ...launcherFixture.appDir)
        const launcherPath = join(appDir, ...launcherFixture.launcher)
        const electronPath = join(appDir, ...launcherFixture.executable)
        const cliPath = join(appDir, ...launcherFixture.cli)

        await mkdir(dirname(launcherPath), { recursive: true })
        await mkdir(dirname(electronPath), { recursive: true })
        await mkdir(dirname(cliPath), { recursive: true })
        await copyFile(launcherFixture.asset, launcherPath)
        await writeFile(cliPath, '', 'utf8')
        await writeFile(
          electronPath,
          `#!/usr/bin/env bash
node -e 'console.log(JSON.stringify({
  argv: process.argv.slice(1),
  runAsNode: process.env.ELECTRON_RUN_AS_NODE,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  hivewardNodeOptions: process.env.HIVEWARD_NODE_OPTIONS ?? null,
  nodeReplExternalModule: process.env.NODE_REPL_EXTERNAL_MODULE ?? null,
  hivewardNodeReplExternalModule: process.env.HIVEWARD_NODE_REPL_EXTERNAL_MODULE ?? null
}))' -- "$@"
`,
          { encoding: 'utf8', mode: 0o755 }
        )

        const result = await execFileAsync(launcherPath, ['--help', 'two words'], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '0',
            NODE_OPTIONS: '--trace-warnings',
            NODE_REPL_EXTERNAL_MODULE: 'external-loader'
          }
        })
        const payload = JSON.parse(result.stdout) as {
          argv: string[]
          runAsNode: string
          nodeOptions: string | null
          hivewardNodeOptions: string | null
          nodeReplExternalModule: string | null
          hivewardNodeReplExternalModule: string | null
        }

        expect(payload.argv).toEqual([cliPath, '--help', 'two words'])
        expect(payload.runAsNode).toBe('1')
        // Hide node options from Electron's bootstrap but preserve them for the CLI.
        expect(payload.nodeOptions).toBeNull()
        expect(payload.hivewardNodeOptions).toBe('--trace-warnings')
        expect(payload.nodeReplExternalModule).toBeNull()
        expect(payload.hivewardNodeReplExternalModule).toBe('external-loader')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

async function waitForListenerState(path: string): Promise<{ pid: number; port: number }> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const state: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (
        typeof state !== 'object' ||
        state === null ||
        !('pid' in state) ||
        typeof state.pid !== 'number' ||
        !Number.isInteger(state.pid) ||
        state.pid <= 0 ||
        !('port' in state) ||
        typeof state.port !== 'number' ||
        !Number.isInteger(state.port) ||
        state.port <= 0 ||
        state.port > 65_535
      ) {
        throw new Error('Invalid launcher listener state')
      }
      return { pid: state.pid, port: state.port }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error('Timed out waiting for launcher listener state')
}

async function waitForPortRelease(port: number): Promise<boolean> {
  const { createConnection } = await import('node:net')
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (!connected) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<readonly [number | null, NodeJS.Signals | null] | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve([child.exitCode, child.signalCode])
      return
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout)
      resolve([code, signal])
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolve(null)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function terminateSyntheticProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  if (await waitForProcessExit(pid, 1_000)) {
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
  if (!(await waitForProcessExit(pid, 1_000))) {
    throw new Error(`Failed to terminate synthetic launcher process ${pid}`)
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return !isProcessAlive(pid)
}
