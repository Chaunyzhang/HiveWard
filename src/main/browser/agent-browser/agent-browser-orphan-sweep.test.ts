import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessMock = vi.fn()
vi.mock('@hiveward/process-host', () => ({
  runProcess: (spec: unknown) => runProcessMock(spec)
}))

import { sweepOrphanedAgentBrowserSessions } from './agent-browser-orphan-sweep'

type Spec = { args?: readonly string[] }

const BIN = '/opt/hiveward/agent-browser'
const SCOPED = {
  env: { AGENT_BROWSER_SOCKET_DIR: '/tmp/hiveward-ab-0123456789abcdef' },
  ownsSocketDirectory: true
}

function respond(sessions: string[]): void {
  runProcessMock.mockImplementation((spec: Spec) => {
    if (spec.args?.[0] === 'session') {
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ success: true, data: { sessions } }),
        stderr: '',
        timedOut: false
      })
    }
    return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
  })
}

function closedArgs(): string[][] {
  return runProcessMock.mock.calls
    .map((call) => [...((call[0] as Spec).args ?? [])])
    .filter((args) => args.includes('close'))
}

describe('agent-browser orphan sweep', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
  })

  it('never closes a daemon outside HiveWard tab naming', async () => {
    respond(['default', 'agent1', 'hiveward-hivewardd-deadbeef', 'hiveward-tab-aaa'])

    await sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })

    expect(closedArgs()).toEqual([['--session', 'hiveward-tab-aaa', 'close']])
  })

  it('leaves sessions this run already owns alone', async () => {
    respond(['hiveward-tab-live', 'hiveward-tab-orphan'])

    await sweepOrphanedAgentBrowserSessions({
      binaryPath: BIN,
      ...SCOPED,
      isSessionLive: (name) => name === 'hiveward-tab-live'
    })

    expect(closedArgs()).toEqual([['--session', 'hiveward-tab-orphan', 'close']])
  })

  it.each([
    ['no socket directory at all', { PATH: 'C:\\Windows' }],
    ['a socket directory HiveWard inherited', { AGENT_BROWSER_SOCKET_DIR: '/tmp/shared-ab' }]
  ])('does not enumerate with %s', async (_label, env) => {
    respond(['hiveward-tab-aaa'])

    const closed = await sweepOrphanedAgentBrowserSessions({
      binaryPath: BIN,
      env,
      ownsSocketDirectory: false
    })

    expect(closed).toEqual([])
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('closes nothing when the listing is unusable', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: 'not json',
      stderr: 'boom',
      timedOut: false
    })

    await expect(
      sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })
    ).resolves.toEqual([])
    expect(closedArgs()).toEqual([])
  })

  it('keeps sweeping after one close fails', async () => {
    runProcessMock.mockImplementation((spec: Spec) => {
      if (spec.args?.[0] === 'session') {
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: JSON.stringify({ data: { sessions: ['hiveward-tab-aaa', 'hiveward-tab-bbb'] } }),
          stderr: '',
          timedOut: false
        })
      }
      if (spec.args?.[1] === 'hiveward-tab-aaa') {
        return Promise.reject(new Error('spawn failed'))
      }
      return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    })

    const closed = await sweepOrphanedAgentBrowserSessions({ binaryPath: BIN, ...SCOPED })

    expect(closed).toEqual(['hiveward-tab-bbb'])
  })
})

describe('sweep kill switch', () => {
  const previous = process.env.HIVEWARD_DISABLE_AGENT_BROWSER_SWEEP

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.HIVEWARD_DISABLE_AGENT_BROWSER_SWEEP
    } else {
      process.env.HIVEWARD_DISABLE_AGENT_BROWSER_SWEEP = previous
    }
  })

  it('enumerates nothing when disabled, even when HiveWard owns the socket directory', async () => {
    process.env.HIVEWARD_DISABLE_AGENT_BROWSER_SWEEP = '1'
    runProcessMock.mockClear()

    const closed = await sweepOrphanedAgentBrowserSessions({
      binaryPath: BIN,
      env: {},
      ownsSocketDirectory: true
    })

    expect(closed).toEqual([])
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
