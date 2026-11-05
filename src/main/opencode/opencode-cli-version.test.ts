import { beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '@hiveward/process-host'
import { probeOpenCodeCliVersion } from './opencode-cli-version'

vi.mock('@hiveward/process-host', () => ({ runProcess: vi.fn() }))
beforeEach(() => vi.mocked(runProcess).mockReset())

it('shares probes across pane identities while preserving launch-affecting environment keys', async () => {
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '2.0.16',
    stderr: '',
    timedOut: false
  })
  const options = {
    executablePath: '/pane-cache/opencode',
    cwd: '/workspace',
    env: {
      PATH: '/runtime',
      OPENCODE_CONFIG_DIR: '/config',
      HIVEWARD_PANE_KEY: 'pane-1',
      HIVEWARD_TAB_ID: 'tab-1',
      HIVEWARD_TERMINAL_HANDLE: 'term-1',
      HIVEWARD_WORKTREE_ID: 'workspace-1',
      HIVEWARD_AGENT_LAUNCH_TOKEN: 'launch-1',
      HIVEWARD_AGENT_PANE: 'pane-1',
      HIVEWARD_AGENT_LAUNCH: 'launch-1'
    },
    hostIdentity: 'pane-cache-host'
  }
  await Promise.all([
    probeOpenCodeCliVersion(options),
    probeOpenCodeCliVersion({
      ...options,
      env: {
        ...options.env,
        HIVEWARD_PANE_KEY: 'pane-2',
        HIVEWARD_TAB_ID: 'tab-2',
        HIVEWARD_TERMINAL_HANDLE: 'term-2',
        HIVEWARD_WORKTREE_ID: 'workspace-2',
        HIVEWARD_AGENT_LAUNCH_TOKEN: 'launch-2',
        HIVEWARD_AGENT_PANE: 'pane-2',
        HIVEWARD_AGENT_LAUNCH: 'launch-2'
      }
    })
  ])
  expect(runProcess).toHaveBeenCalledTimes(1)
  await probeOpenCodeCliVersion({ ...options, env: { ...options.env, PATH: '/other-runtime' } })
  await probeOpenCodeCliVersion({
    ...options,
    env: { ...options.env, OPENCODE_CONFIG_DIR: '/other-config' }
  })
  await probeOpenCodeCliVersion({ ...options, cwd: '/other-workspace' })
  expect(runProcess).toHaveBeenCalledTimes(4)
})

it('separates native and host-callback backends even with the same host identity', async () => {
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '1.18.32',
    stderr: '',
    timedOut: false
  })
  const options = { executablePath: '/backend/opencode', env: {}, hostIdentity: 'backend-host' }
  expect((await probeOpenCodeCliVersion(options)).pluginApi).toBe('v1')
  const execute = vi.fn(async () => ({ code: 0, timedOut: false, stdout: '2.0.16' }))
  expect((await probeOpenCodeCliVersion({ ...options, execute })).pluginApi).toBe('v2')
  expect(execute).toHaveBeenCalledOnce()
  expect(runProcess).toHaveBeenCalledOnce()
})
