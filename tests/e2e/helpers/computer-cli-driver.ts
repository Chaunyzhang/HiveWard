import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createElectronHomeIsolation } from './electron-home-isolation'

const execFileAsync = promisify(execFile)
const RUNTIME_METADATA_FILE = 'hiveward-runtime.json'
let HivewarddevUserDataPath: string | null = null
let hivewardServeProcess: ChildProcess | null = null
let hivewardServeStdout = ''
let hivewardServeStderr = ''

export type CliResult = {
  stdout: string
  stderr: string
}

type RunHiveWardCliOptions = {
  retryMissingRuntimeMetadata?: boolean
}

export async function runHiveWardCli(
  args: string[],
  options: RunHiveWardCliOptions = {}
): Promise<CliResult> {
  try {
    return await runHiveWardCliOnce(args)
  } catch (error) {
    if (
      options.retryMissingRuntimeMetadata !== false &&
      isMissingRuntimeMetadataError(args, error)
    ) {
      // Windows can lose the dev runtime while launching the fixture app; reopen once before the desktop action.
      await ensureHiveWardRuntimeLaunched()
      return await runHiveWardCliOnce(args)
    }
    throw error
  }
}

async function runHiveWardCliOnce(args: string[]): Promise<CliResult> {
  const devCli = join(process.cwd(), 'config/scripts/hiveward-dev.mjs')
  const command = process.env.HIVEWARD_COMPUTER_CLI ?? process.execPath
  const cliArgs = process.env.HIVEWARD_COMPUTER_CLI ? args : [devCli, ...args]
  const env = process.env.HIVEWARD_COMPUTER_CLI
    ? { ...process.env }
    : await createComputerE2ERuntimeEnv()
  try {
    const result = await execFileAsync(command, cliArgs, {
      env,
      maxBuffer: 20 * 1024 * 1024
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && 'stderr' in error) {
      const output = error as { message: string; stdout: string; stderr: string }
      throw new Error(`${output.message}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`)
    }
    throw error
  }
}

export async function ensureHiveWardRuntimeLaunched(): Promise<void> {
  if (!process.env.HIVEWARD_COMPUTER_CLI && process.platform === 'win32') {
    await ensureHiveWardRuntimeServed()
    return
  }
  await runHiveWardCli(['open', '--json'], { retryMissingRuntimeMetadata: false })
  await waitForHiveWardRuntimeReady()
}

export async function stopHiveWardRuntime(): Promise<void> {
  const processToStop = hivewardServeProcess
  if (!processToStop?.pid) {
    return
  }
  hivewardServeProcess = null
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(processToStop.pid), '/T', '/F'])
    } catch {
      // The foreground test runtime may already have exited.
    }
    return
  }
  processToStop.kill()
}

export function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T
}

async function getComputerE2eHivewarddevUserDataPath(): Promise<string> {
  if (!HivewarddevUserDataPath) {
    // Use a fresh profile so a retained dev runtime cannot execute stale provider code.
    HivewarddevUserDataPath = await mkdtemp(join(tmpdir(), 'hiveward-computer-runtime-'))
  }
  return HivewarddevUserDataPath
}

async function waitForHiveWardRuntimeReady(): Promise<void> {
  const userDataPath = await getComputerE2eHivewarddevUserDataPath()
  const metadataPath = join(userDataPath, RUNTIME_METADATA_FILE)
  const deadline = Date.now() + 15000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      await access(metadataPath)
      const status = parseJsonOutput<{
        result: { runtime: { reachable: boolean } }
      }>((await runHiveWardCli(['status', '--json'], { retryMissingRuntimeMetadata: false })).stdout)
      if (status.result.runtime.reachable) {
        return
      }
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  const detail = [
    lastError instanceof Error ? `Last error: ${lastError.message}` : null,
    hivewardServeStdout.trim() ? `serve stdout: ${hivewardServeStdout.trim()}` : null,
    hivewardServeStderr.trim() ? `serve stderr: ${hivewardServeStderr.trim()}` : null
  ]
    .filter(Boolean)
    .join(' ')
  throw new Error(`HiveWard runtime metadata was not ready at ${metadataPath}.${detail}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureHiveWardRuntimeServed(): Promise<void> {
  if (!hivewardServeProcess || hivewardServeProcess.exitCode !== null) {
    const devCli = join(process.cwd(), 'config/scripts/hiveward-dev.mjs')
    const env = await createComputerE2ERuntimeEnv()
    hivewardServeStdout = ''
    hivewardServeStderr = ''
    hivewardServeProcess = spawn(process.execPath, [devCli, 'serve', '--no-pairing', '--json'], {
      env,
      windowsHide: true
    })
    hivewardServeProcess.stdout?.on('data', (chunk) => {
      hivewardServeStdout += String(chunk)
    })
    hivewardServeProcess.stderr?.on('data', (chunk) => {
      hivewardServeStderr += String(chunk)
    })
    hivewardServeProcess.once('exit', () => {
      hivewardServeProcess = null
    })
    process.once('exit', () => {
      hivewardServeProcess?.kill()
    })
  }
  await waitForHiveWardRuntimeReady()
}

async function createComputerE2ERuntimeEnv(): Promise<NodeJS.ProcessEnv> {
  const userDataDir =
    process.env.HIVEWARD_DEV_USER_DATA_PATH ?? (await getComputerE2eHivewarddevUserDataPath())
  // Strip ELECTRON_RUN_AS_NODE or the Electron child runs as plain Node.
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...inheritedEnv } = process.env
  void _electronRunAsNode
  const isolation = createElectronHomeIsolation({
    inheritedEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir
  })
  return {
    ...isolation.env,
    // Keep CLI and Electron on the same runtime metadata while fixture HOME/Codex isolation remains in force.
    HIVEWARD_DEV_USER_DATA_PATH: userDataDir
  }
}

function isMissingRuntimeMetadataError(args: string[], error: unknown): boolean {
  if (args[0] !== 'computer') {
    return false
  }
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false
  }
  const message = String((error as { message?: unknown }).message)
  return (
    message.includes('"code": "runtime_unavailable"') &&
    message.includes('Could not read HiveWard runtime metadata')
  )
}
