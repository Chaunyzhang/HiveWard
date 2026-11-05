import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  installManagedAgentHooks: vi.fn(),
  resolveStartupManagedHookAction: vi.fn(),
  shouldContinueManagedHookStartup: vi.fn()
}))
vi.mock('./managed-agent-hook-controls', () => mocks)

import { reconcileStartupManagedAgentHooks } from './managed-agent-hook-startup'

describe('reconcileStartupManagedAgentHooks', () => {
  beforeEach(() => {
    mocks.installManagedAgentHooks.mockReset().mockResolvedValue([])
    mocks.resolveStartupManagedHookAction.mockReset().mockReturnValue('install')
    mocks.shouldContinueManagedHookStartup.mockReset().mockReturnValue(true)
  })

  it('forwards an optional agent filter to installation', () => {
    const settings = { agentStatusHooksEnabled: true }
    reconcileStartupManagedAgentHooks({
      getSettings: () => settings,
      isQuitting: () => false,
      shouldHydrateShellPath: false,
      agents: ['kimi']
    })

    expect(mocks.installManagedAgentHooks).toHaveBeenCalledWith(
      settings,
      expect.objectContaining({ agents: ['kimi'] })
    )
  })
})
