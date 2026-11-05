import type { HiveWardRuntimeService } from '../hiveward-runtime'
import type { StructuredSessionSurfaceRuntime } from '../agent-session/structured-agent-session-close'

export type WorkerTerminalReleaseRuntime = StructuredSessionSurfaceRuntime &
  Pick<
    HiveWardRuntimeService,
    | 'forgetStructuredSessionMail'
    | 'resolveOrchestrationWorkerServer'
    | 'callOrchestrationWorkerServer'
    | 'getOrchestrationFleetAgentStatusSnapshot'
    | 'getOrchestrationDb'
    | 'showTerminal'
    | 'resolveTerminalHandleByProcessIncarnation'
    | 'getTerminalPaneKey'
    | 'getTerminalProcessIncarnation'
    | 'getTerminalLivenessVerdict'
    | 'checkTerminalAgentPresence'
    | 'getOrchestrationDispatchAuthority'
    | 'ensureStructuredAgentSessionHost'
    | 'inspectTerminalProcessIncarnationLiveness'
    | 'closeTerminal'
    | 'getExactWorkerProviderSession'
    | 'readTerminal'
    | 'notifyMessageArrived'
    | 'isWorkerAgentInTurn'
  >
