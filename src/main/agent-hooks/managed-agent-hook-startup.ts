import type { AgentHookTarget } from '../../shared/agent-hook-types'
import {
  installManagedAgentHooks,
  resolveStartupManagedHookAction,
  shouldContinueManagedHookStartup
} from './managed-agent-hook-controls'

type StartupHookSettings = NonNullable<Parameters<typeof installManagedAgentHooks>[0]>

export function reconcileStartupManagedAgentHooks(host: {
  getSettings: () => StartupHookSettings
  isQuitting: () => boolean
  shouldHydrateShellPath: boolean
  agents?: readonly AgentHookTarget[]
}): void {
  if (resolveStartupManagedHookAction(host.getSettings()) !== 'install') {
    return
  }
  void installManagedAgentHooks(host.getSettings(), {
    agents: host.agents,
    shouldHydrateShellPath: host.shouldHydrateShellPath,
    shouldContinue: (agent) =>
      shouldContinueManagedHookStartup(host.isQuitting(), host.getSettings(), agent)
  }).catch((error: unknown) =>
    console.warn('[agent-hooks] failed to reconcile managed hooks on startup:', error)
  )
}
