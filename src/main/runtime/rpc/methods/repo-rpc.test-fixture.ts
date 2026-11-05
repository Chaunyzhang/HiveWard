import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { HiveWardRuntimeService } from '../../hiveward-runtime'
import { REPO_METHODS } from './repo'

export function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

export function repoDispatcher(
  runtime: Pick<HiveWardRuntimeService, 'getRuntimeId'> & Partial<HiveWardRuntimeService>
) {
  return new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These RPC cases supply every runtime method their handlers and envelope access.
    runtime: runtime as HiveWardRuntimeService,
    methods: REPO_METHODS
  })
}
