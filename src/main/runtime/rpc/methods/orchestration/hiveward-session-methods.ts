import { defineMethod } from '../../core'
import {
  registerHivewardExternalSession,
  hivewardExternalCaller
} from '../../../orchestration/hiveward-external-sessions'
import { HivewardSessionRegisterParams } from '../../../../../shared/rpc-contract/hiveward-orchestration-session-params'

export const HIVEWARD_SESSION_METHODS = [
  defineMethod({
    name: 'orchestration.hivewardSessionRegister',
    permission: 'workspace',
    params: HivewardSessionRegisterParams,
    handler: async (params, { runtime }) => {
      const workspace = await runtime.showManagedTerminalWorkspace(`path:${params.path}`)
      const row = registerHivewardExternalSession(runtime.getOrchestrationDb(), {
        ...params,
        workspaceId: workspace.id
      })
      return {
        ...row,
        address: hivewardExternalCaller(runtime.getOrchestrationDb(), row.sessionId).address
      }
    }
  })
]
