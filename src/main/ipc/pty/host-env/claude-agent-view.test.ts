import { delimiter } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { applyClaudeAgentViewEnv } from './claude-agent-view'
import type { BuildPtyHostEnvOptions } from './types'

const read = vi.hoisted(() => vi.fn())
vi.mock('../../../claude/agent-view/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ read })
}))

const options: BuildPtyHostEnvOptions = {
  userDataPath: '/hiveward',
  isPackaged: false,
  selectedCodexHomePath: null,
  agentStatusHooksEnabled: true
}

afterEach(() => {
  vi.unstubAllEnvs()
  read.mockReset()
})

it('strips only a previously inherited HiveWard path when disabled', () => {
  vi.stubEnv('HIVEWARD_CLAUDE_AGENT_VIEW_PLUGIN_DIR', '/hiveward/previous')
  vi.stubEnv('CLAUDE_CODE_PLUGIN_DIRS', `/user/plugin${delimiter}/hiveward/previous`)
  const env = {}
  applyClaudeAgentViewEnv(env, { ...options, claudeSubagentNavigationEnabled: false })
  expect(env).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: '/user/plugin' })
})
