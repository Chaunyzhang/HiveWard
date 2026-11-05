import { describe, expect, it } from 'vitest'
import {
  applyScrubSafeAgentEnvAliases,
  HIVEWARD_SCRUB_SAFE_LAUNCH_ENV,
  HIVEWARD_SCRUB_SAFE_PANE_ENV
} from './agent-hook-scrub-safe-env'

/** The rule DeepSeek Harness's shell executor applies, measured against dsh 0.1.5-rc.1. */
function isScrubbedName(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD/.test(name)
}

describe('applyScrubSafeAgentEnvAliases', () => {
  it('mirrors pane identity onto names a credential scrub keeps', () => {
    const env: Record<string, string> = {
      HIVEWARD_PANE_KEY: 'tab-1:11111111-1111-4111-8111-111111111111',
      HIVEWARD_AGENT_LAUNCH_TOKEN: 'launch-abc'
    }
    applyScrubSafeAgentEnvAliases(env)
    expect(env[HIVEWARD_SCRUB_SAFE_PANE_ENV]).toBe(env.HIVEWARD_PANE_KEY)
    expect(env[HIVEWARD_SCRUB_SAFE_LAUNCH_ENV]).toBe(env.HIVEWARD_AGENT_LAUNCH_TOKEN)
  })

  it('picks alias names the scrub does not take', () => {
    expect(isScrubbedName(HIVEWARD_SCRUB_SAFE_PANE_ENV)).toBe(false)
    expect(isScrubbedName(HIVEWARD_SCRUB_SAFE_LAUNCH_ENV)).toBe(false)
    expect(isScrubbedName('HIVEWARD_PANE_KEY')).toBe(true)
    expect(isScrubbedName('HIVEWARD_AGENT_LAUNCH_TOKEN')).toBe(true)
  })

  it('leaves the canonical names untouched', () => {
    const env: Record<string, string> = { HIVEWARD_PANE_KEY: 'pane', HIVEWARD_AGENT_LAUNCH_TOKEN: 'tok' }
    applyScrubSafeAgentEnvAliases(env)
    expect(env.HIVEWARD_PANE_KEY).toBe('pane')
    expect(env.HIVEWARD_AGENT_LAUNCH_TOKEN).toBe('tok')
  })

  it('drops a stale alias when its source is gone', () => {
    // Inherited stale aliases would attribute hooks to the parent pane.
    const env: Record<string, string> = {
      [HIVEWARD_SCRUB_SAFE_PANE_ENV]: 'inherited-pane',
      [HIVEWARD_SCRUB_SAFE_LAUNCH_ENV]: 'inherited-launch'
    }
    applyScrubSafeAgentEnvAliases(env)
    expect(env[HIVEWARD_SCRUB_SAFE_PANE_ENV]).toBeUndefined()
    expect(env[HIVEWARD_SCRUB_SAFE_LAUNCH_ENV]).toBeUndefined()
  })

  it('treats an empty source as absent', () => {
    const env: Record<string, string> = {
      HIVEWARD_PANE_KEY: '',
      [HIVEWARD_SCRUB_SAFE_PANE_ENV]: 'stale'
    }
    applyScrubSafeAgentEnvAliases(env)
    expect(env[HIVEWARD_SCRUB_SAFE_PANE_ENV]).toBeUndefined()
  })
})
