import { NODE_RUNTIME_PIN } from './node-runtime-pin'
import type { HivewarddPreflightRuntimeIdentity } from './hivewardd-profile-preflight'

/** What a Node slot's candidate must report: the pinned runtime, never a host Node. */
export const HIVEWARDD_NODE_RUNTIME_IDENTITY: HivewarddPreflightRuntimeIdentity = {
  runtime: 'node',
  runtimeVersion: NODE_RUNTIME_PIN.version
}
