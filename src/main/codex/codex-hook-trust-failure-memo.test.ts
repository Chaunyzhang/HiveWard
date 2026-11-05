import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as AppServerSession from './app-server/codex-app-server-session'

const mocks = vi.hoisted(() => ({
  runCodexAppServerSession: vi.fn(),
  runProcess: vi.fn()
}))

vi.mock('./app-server/codex-app-server-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AppServerSession>()),
  runCodexAppServerSession: mocks.runCodexAppServerSession
}))
vi.mock('@hiveward/process-host', () => ({ runProcess: mocks.runProcess }))

import { CodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import { CodexAppServerUnsupportedError } from './app-server/codex-app-server-session'
import {
  _internals,
  lookupCodexHookAnswer,
  startCodexHookHashLookup
} from './codex-hook-hash-lookup'
import { getCodexHookTrustMemoPath } from './codex-hook-trust-memo'

const COMMAND = '/home/u/.hiveward/agent-hooks/codex-hook.sh'
let userData: string
let codexPath: string

function startProcess(): void {
  _internals.resetForTesting()
  startCodexHookHashLookup(Promise.resolve())
}

// movedHash controls the shifted copy; listsHiveWard=false leaves only the dummy hook.
function listHashedHooks(movedHash = 'sha256:stop', listsHiveWard = true): void {
  mocks.runCodexAppServerSession.mockImplementation(
    async (invocation: { env?: Record<string, string> }, body: (rpc: unknown) => unknown) => {
      let project = ''
      await body({
        request: async (_method: string, params: { cwds: string[] }) => {
          project = params.cwds[0]!
        }
      })
      const home = join(invocation.env!.CODEX_HOME!, 'hooks.json')
      const projectHooks = join(project, '.codex', 'hooks.json')
      const listing = (sourcePath: string, groupIndex: number, hash = 'sha256:stop') => ({
        key: `${sourcePath}:stop:${groupIndex}:0`,
        eventName: 'stop',
        command: groupIndex === 1 ? 'exit 0' : COMMAND,
        sourcePath,
        currentHash: hash
      })
      const hiveward = [listing(home, 0), listing(home, 2, movedHash), listing(projectHooks, 0)]
      const hooks = [listing(home, 1, 'sha256:dummy'), ...(listsHiveWard ? hiveward : [])]
      return { data: [{ cwd: project, hooks }] }
    }
  )
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'hiveward-codex-trust-failure-'))
  vi.stubEnv('HIVEWARD_USER_DATA_PATH', userData)
  codexPath = join(userData, 'codex')
  writeFileSync(codexPath, 'codex 0.150.1')
  mocks.runProcess.mockResolvedValue({ code: 0, stdout: 'codex-cli 0.150.1\n', stderr: '' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  startProcess()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  _internals.resetForTesting()
  rmSync(userData, { recursive: true, force: true })
})

describe('a failed ask of Codex', () => {
  it.each([
    [
      'an app-server that exits early',
      new Error('codex app-server exited before completing the session: panicked')
    ],
    [
      'a JSON-RPC error from hooks/list',
      new CodexAppServerRequestError('hooks/list', -32603, 'codex app-server hooks/list failed')
    ]
  ])('is pending and unsaved after %s, and asked again after the window', async (_, error) => {
    mocks.runCodexAppServerSession.mockRejectedValueOnce(error)

    const failed = await lookupCodexHookAnswer(codexPath, COMMAND)

    expect(failed.kind).toBe('pending')
    expect(existsSync(getCodexHookTrustMemoPath())).toBe(false)
    expect((await lookupCodexHookAnswer(codexPath, COMMAND)).kind).toBe('pending')
    expect(mocks.runCodexAppServerSession).toHaveBeenCalledTimes(1)
    listHashedHooks()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    expect((await lookupCodexHookAnswer(codexPath, COMMAND)).kind).toBe('hashes')
  })
})

describe("Codex's definitive answer", () => {
  it.each([
    [
      'it has no hooks/list',
      1,
      () =>
        mocks.runCodexAppServerSession.mockRejectedValue(
          new CodexAppServerUnsupportedError('method not found: hooks/list')
        )
    ],
    ["it does not list HiveWard's entry", 1, () => listHashedHooks('sha256:stop', false)],
    ['it hashes a moved copy differently, twice', 2, () => listHashedHooks('sha256:moved')]
  ])('is refused and saved for the version when %s', async (_, asks, answer) => {
    answer()

    expect((await lookupCodexHookAnswer(codexPath, COMMAND)).kind).toBe('refused')
    startProcess()
    expect((await lookupCodexHookAnswer(codexPath, COMMAND)).kind).toBe('refused')
    expect(existsSync(getCodexHookTrustMemoPath())).toBe(true)
    expect(mocks.runCodexAppServerSession).toHaveBeenCalledTimes(asks)
  })
})
