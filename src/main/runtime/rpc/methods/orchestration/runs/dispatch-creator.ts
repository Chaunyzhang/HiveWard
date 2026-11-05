import type { DispatchCreator } from '../../../../orchestration/db/dispatch-depth'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import type { HiveWardRuntimeService } from '../../../../hiveward-runtime'
import { orchestrationCallerIdentity } from './run-scope'

/** Use runtime-attested pane/incarnation for nesting identity; remote attachment matching requires the exact process and params are untrusted. */
export function resolveDispatchCreator(
  runtime: HiveWardRuntimeService,
  callerHandle: string | undefined,
  callerSession: OrchestrationSessionCaller | undefined
): DispatchCreator {
  if (!callerHandle) {
    // No declared caller resolves no parent; retain legacy Run-binding depth zero.
    return { kind: 'system' }
  }
  const caller = orchestrationCallerIdentity(runtime, {
    handle: callerHandle,
    session: callerSession,
    paneKey: null
  })
  if (caller.terminalHandle === null) {
    // A handle-less session: its HiveWard session id is its whole identity.
    return caller.hivewardSessionId
      ? { kind: 'session', hivewardSessionId: caller.hivewardSessionId }
      : { kind: 'system' }
  }
  const authority = runtime.getOrchestrationDispatchAuthority?.(caller.terminalHandle)
  return {
    kind: 'terminal',
    handle: caller.terminalHandle,
    paneKey:
      authority?.paneKey ??
      caller.paneKey ??
      runtime.getTerminalPaneKey(caller.terminalHandle) ??
      undefined,
    processIncarnation: authority?.processIncarnation ?? undefined,
    ...(caller.hivewardSessionId ? { hivewardSessionId: caller.hivewardSessionId } : {})
  }
}
