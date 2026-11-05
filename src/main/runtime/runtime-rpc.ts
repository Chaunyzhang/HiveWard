// Why: the single security boundary for the bundled CLI — auth-token enforcement, metadata publication, transport orchestration.
import { RuntimeRpcShutdown } from './runtime-rpc/runtime-rpc-shutdown'
import type { HiveWardRuntimeRpcServerOptions } from './runtime-rpc/runtime-rpc-pairing-types'

export class HiveWardRuntimeRpcServer extends RuntimeRpcShutdown {
  constructor(options: HiveWardRuntimeRpcServerOptions) {
    super(options)
  }
}
