import { describe, expect, it, vi } from 'vitest'
import { quoteWindowsArgument } from '@hiveward/process-host/windows-command-line'
import {
  HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT,
  parseWindowsBreakawayLaunchReport,
  WINDOWS_BREAKAWAY_EXIT_CODES as RELAY_WINDOWS_BREAKAWAY_EXIT_CODES,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG as RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  type WindowsBreakawayLaunchContract
} from './windows-breakaway-launch'
import {
  launchOutsideJob,
  loadWindowsBreakawayLauncher,
  parseWindowsBreakawayLaunchRequest,
  type SpawnOutsideJob,
  type WindowsBreakawayLauncher
} from './windows-breakaway-launcher'

// The launcher is contract-agnostic; this stands in for the retired relay's contract.
const RELAY_WINDOWS_BREAKAWAY_CONTRACT: WindowsBreakawayLaunchContract = {
  argsFlag: '--relay-args',
  reportMarker: 'HIVEWARD_RELAY_LAUNCH'
}

const parseRelayWindowsBreakawayLaunch = (args: readonly string[]) =>
  parseWindowsBreakawayLaunchRequest(RELAY_WINDOWS_BREAKAWAY_CONTRACT, args)

function launcherFor(
  spawn: SpawnOutsideJob,
  creationTimeMs: number | null = null
): WindowsBreakawayLauncher {
  return { spawnOutsideJob: spawn, readCreationTimeMs: () => creationTimeMs }
}

const launchRelayOutsideJob = (
  request: Parameters<typeof launchOutsideJob>[0],
  launcher: SpawnOutsideJob | string,
  runtime: { execPath: string; relayScript: string; cwd: string }
) =>
  launchOutsideJob(request, typeof launcher === 'string' ? launcher : launcherFor(launcher), {
    execPath: runtime.execPath,
    script: runtime.relayScript,
    cwd: runtime.cwd
  })

const argv = [
  'C:\\rt\\node.exe',
  'C:\\Users\\me user\\.hiveward-remote\\relay-1\\relay.js',
  RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  '--stdout-file',
  'C:/Users/me user/relay.log',
  '--stderr-file',
  'C:/Users/me user/relay.err.log',
  '--relay-args',
  '--detached',
  '--sock-path',
  '\\\\.\\pipe\\hiveward-relay-1',
  '--log-file',
  'C:/Users/me user/relay.log'
]
const runtime = { execPath: argv[0], relayScript: argv[1], cwd: 'C:\\Users\\me user' }

function requestFrom(args: readonly string[]) {
  const request = parseRelayWindowsBreakawayLaunch(args)
  if (!request) {
    throw new Error('expected a launch request')
  }
  return request
}

describe('relay Windows breakaway launcher', () => {
  it('takes its own flags before -- and hands the rest to the relay', () => {
    expect(parseRelayWindowsBreakawayLaunch(argv)).toEqual({
      stdoutPath: 'C:/Users/me user/relay.log',
      stderrPath: 'C:/Users/me user/relay.err.log',
      env: {},
      programArgs: argv.slice(8)
    })
  })

  it('refuses a request without its output files', () => {
    expect(() =>
      parseRelayWindowsBreakawayLaunch(['node', 'relay.js', RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG])
    ).toThrow('--stdout-file')
  })

  it('starts the same node and relay script with the relay args, quoted for CommandLineToArgvW', () => {
    const spawn = vi.fn<SpawnOutsideJob>(() => ({ ok: true, pid: 4242, inJob: false }))

    const outcome = launchRelayOutsideJob(requestFrom(argv), spawn, runtime)

    expect(outcome).toEqual({
      report: { method: 'breakaway', pid: 4242, inJob: false },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.launched
    })
    expect(spawn).toHaveBeenCalledWith(
      runtime.execPath,
      [runtime.execPath, runtime.relayScript, ...argv.slice(8)].map(quoteWindowsArgument).join(' '),
      runtime.cwd,
      'C:/Users/me user/relay.log',
      'C:/Users/me user/relay.err.log'
    )
  })

  it('reports a job that refuses breakaway as unavailable so the script can try WMI', () => {
    const spawn: SpawnOutsideJob = () => ({
      ok: false,
      reason: 'breakaway-denied',
      step: 'create-process',
      code: 5
    })

    expect(launchRelayOutsideJob(requestFrom(argv), spawn, runtime)).toEqual({
      report: {
        method: 'unavailable',
        reason: 'breakaway-denied',
        step: 'create-process',
        code: 5
      },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.unavailable
    })
  })

  it('reports any other CreateProcess failure as failed, without a WMI retry', () => {
    const spawn: SpawnOutsideJob = () => ({
      ok: false,
      reason: 'failed',
      step: 'open-stdout',
      code: 32
    })

    expect(launchRelayOutsideJob(requestFrom(argv), spawn, runtime)).toEqual({
      report: { method: 'failed', reason: 'failed', step: 'open-stdout', code: 32 },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.failed
    })
  })

  it('names an absent addon and one that predates the launcher', () => {
    expect(
      loadWindowsBreakawayLauncher(() => {
        throw new Error('Cannot find module')
      }, 'win32')
    ).toBe('addon-missing')
    expect(loadWindowsBreakawayLauncher(() => ({ getProcessList: () => {} }), 'win32')).toBe(
      'addon-predates-launcher'
    )
  })

  it('reads an unrecognised addon result as a failure', () => {
    const launcher = loadWindowsBreakawayLauncher(
      () => ({ spawnOutsideJob: () => ({ ok: true }) }),
      'win32'
    )
    if (typeof launcher === 'string') {
      throw new Error(`expected a launcher, got ${launcher}`)
    }
    expect(launcher.spawnOutsideJob('a', 'b', 'c', 'd', 'e')).toEqual({
      ok: false,
      reason: 'unrecognized-result',
      step: 'create-process',
      code: 0
    })
  })

  it('never binds the addon off Windows', () => {
    expect(loadWindowsBreakawayLauncher(() => ({ spawnOutsideJob: () => ({}) }), 'linux')).toBe(
      'not-windows'
    )
  })

  it('reads creation time only as a positive number from an addon that has the getter', () => {
    const load = (getProcessCreationTime?: (pid: number) => unknown) => {
      const launcher = loadWindowsBreakawayLauncher(
        () => ({ spawnOutsideJob: () => ({}), getProcessCreationTime }),
        'win32'
      )
      if (typeof launcher === 'string') {
        throw new Error(`expected a launcher, got ${launcher}`)
      }
      return launcher.readCreationTimeMs(7)
    }
    expect(load((pid) => (pid === 7 ? 1_700_000_000_123 : undefined))).toBe(1_700_000_000_123)
    expect(load(() => undefined)).toBeNull()
    expect(load(() => 0)).toBeNull()
    expect(load()).toBeNull()
  })
})

describe('hivewardd Windows breakaway launcher', () => {
  const hivewarddArgv = [
    'C:\\rt\\node.exe',
    'C:\\Users\\me\\.hiveward-remote\\hivewardd-1\\hivewardd.js',
    RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG,
    '--stdout-file',
    'C:/slot/.hivewardd-readiness',
    '--stderr-file',
    'C:/slot/hivewardd.log',
    '--process-file',
    'C:/slot/.hivewardd-process.json',
    '--hivewardd-args',
    '--json',
    '--bind',
    '127.0.0.1'
  ]
  const hivewarddRuntime = { execPath: hivewarddArgv[0], script: hivewarddArgv[1], cwd: 'C:/slot' }

  it('splits on its own args flag, not the relay one', () => {
    expect(parseWindowsBreakawayLaunchRequest(HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT, hivewarddArgv)).toEqual(
      {
        stdoutPath: 'C:/slot/.hivewardd-readiness',
        stderrPath: 'C:/slot/hivewardd.log',
        processFilePath: 'C:/slot/.hivewardd-process.json',
        env: {},
        programArgs: ['--json', '--bind', '127.0.0.1']
      }
    )
  })

  it('collects --env assignments for the launched process and refuses a malformed one', () => {
    const withEnv = [
      ...hivewarddArgv.slice(0, 3),
      '--env',
      'HIVEWARD_VERSION=0.2.0+bb01',
      '--env',
      'HIVEWARD_USER_DATA=C:/Users/Ann Lee/.hiveward',
      ...hivewarddArgv.slice(3)
    ]
    expect(
      parseWindowsBreakawayLaunchRequest(HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT, withEnv)?.env
    ).toEqual({ HIVEWARD_VERSION: '0.2.0+bb01', HIVEWARD_USER_DATA: 'C:/Users/Ann Lee/.hiveward' })
    expect(() =>
      parseWindowsBreakawayLaunchRequest(HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT, [
        ...hivewarddArgv.slice(0, 3),
        '--env',
        'lower=1',
        ...hivewarddArgv.slice(3)
      ])
    ).toThrow('NAME=VALUE')
  })

  it.each([
    'HIVEWARD_PAIRING_TOKEN',
    'HIVEWARD_RUNTIME_SECRET',
    'ANTHROPIC_API_KEY',
    'DB_PASSWORD',
    'HIVEWARD_CREDENTIAL_FILE'
  ])('refuses the secret-shaped name %s on --env', (name) => {
    expect(() =>
      parseWindowsBreakawayLaunchRequest(HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT, [
        ...hivewarddArgv.slice(0, 3),
        '--env',
        `${name}=x`,
        ...hivewarddArgv.slice(3)
      ])
    ).toThrow('argv is not secret')
  })

  it('records the PID with its creation time so a reused PID is never mistaken for it', () => {
    const request = parseWindowsBreakawayLaunchRequest(HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT, hivewarddArgv)
    if (!request) {
      throw new Error('expected a launch request')
    }
    const writes: [string, string][] = []
    const outcome = launchOutsideJob(
      request,
      launcherFor(() => ({ ok: true, pid: 4242, inJob: false }), 1_700_000_000_123),
      hivewarddRuntime,
      (path, contents) => writes.push([path, contents])
    )
    expect(outcome).toEqual({
      report: { method: 'breakaway', pid: 4242, inJob: false, creationTimeMs: 1_700_000_000_123 },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.launched
    })
    expect(writes).toEqual([
      ['C:/slot/.hivewardd-process.json', '{"pid":4242,"creationTimeMs":1700000000123}']
    ])
  })

  it('fails the launch and stops the process when its record cannot be written', () => {
    const request = parseWindowsBreakawayLaunchRequest(HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT, hivewarddArgv)
    if (!request) {
      throw new Error('expected a launch request')
    }
    const terminated: number[] = []
    const outcome = launchOutsideJob(
      request,
      launcherFor(() => ({ ok: true, pid: 4242, inJob: false })),
      hivewarddRuntime,
      () => {
        throw Object.assign(new Error('EACCES'), { errno: -4048 })
      },
      (pid) => terminated.push(pid)
    )
    expect(outcome).toEqual({
      report: { method: 'failed', reason: 'process-file', code: -4048 },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.failed
    })
    expect(terminated).toEqual([4242])
  })

  it('reports under its own marker, which the relay parser does not read', () => {
    const line = 'HIVEWARD_HIVEWARDD_LAUNCH {"method":"breakaway","pid":9,"inJob":false}'
    expect(parseWindowsBreakawayLaunchReport(HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT, line)).toEqual({
      method: 'breakaway',
      pid: 9,
      inJob: false
    })
    expect(parseWindowsBreakawayLaunchReport(RELAY_WINDOWS_BREAKAWAY_CONTRACT, line)).toBeNull()
  })
})
