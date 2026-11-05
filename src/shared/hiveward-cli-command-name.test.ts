import { describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'

const agentTeams = TUI_AGENT_CONFIG['claude-agent-teams']

describe('Claude Agent Teams launch name on the launching host', () => {
  it('uses plain hiveward on a headless Linux server, whose PATH has no hiveward (#33920)', () => {
    installFakeAppEnvironment({ getCliLauncherPath: () => '/home/u/.hiveward/cli/bin/hiveward' })
    expect(getTuiAgentLaunchCommand(agentTeams, 'linux')).toBe('hiveward claude-teams')
  })

  it('keeps the hiveward rename on a Linux desktop', () => {
    installFakeAppEnvironment({ getCliLauncherPath: undefined })
    expect(getTuiAgentLaunchCommand(agentTeams, 'linux')).toBe('hiveward claude-teams')
  })

  it('keeps the hiveward rename for WSL under a Windows server', () => {
    installFakeAppEnvironment({
      getCliLauncherPath: () => 'C:\\Users\\u\\.hiveward\\cli\\bin\\hiveward.exe'
    })
    expect(getTuiAgentLaunchCommand(agentTeams, 'linux')).toBe('hiveward claude-teams')
  })
})
