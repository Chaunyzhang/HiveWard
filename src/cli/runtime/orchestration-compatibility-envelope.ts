import { HIVEWARD_ORCHESTRATION_SESSION_ENV } from '../../shared/hiveward-session-address'
import { randomUUID } from 'node:crypto'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/agent-session-caller-env'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'

export function createOrchestrationCompatibilityEnvelope(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope {
  const hivewardSessionId = env[HIVEWARD_ORCHESTRATION_SESSION_ENV]
  const evidence = readOrchestrationCompatibilityEvidence(env)
  if (hivewardSessionId) {
    return {
      compatibilityInvocationId: randomUUID(),
      hivewardSessionId,
      orchestrationCompatibilityEvidence: evidence
    }
  }
  // Only local environment session ids can identify a session on this host.
  const agentSessionId = readInjectedAgentSessionId(env)
  return {
    compatibilityInvocationId: randomUUID(),
    orchestrationCompatibilityEvidence: agentSessionId ? { ...evidence, agentSessionId } : evidence
  }
}

/** The chat an agent launch came from, so the host can show the launched agent there.
 *  Only a same-host session can be named: host-stamped (WSL) environments send nothing. */
export function createAgentLaunchCallerEvidence(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope['orchestrationCompatibilityEvidence'] {
  const agentSessionId = readInjectedAgentSessionId(env)
  if (!agentSessionId || readOrchestrationCompatibilityEvidence(env)?.host) {
    return undefined
  }
  return { agentSessionId }
}
