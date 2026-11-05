import type { HiveWardRuntimeService } from '../hiveward-runtime'

export type FederationRuntime = Pick<
  HiveWardRuntimeService,
  | 'syncOrchestrationFederatedDispatch'
  | 'getOrchestrationDb'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
  | 'notifyMessageArrived'
  | 'reconcileLegacyWorkerTerminals'
>
