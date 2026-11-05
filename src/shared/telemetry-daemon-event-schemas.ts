import { z } from 'zod'
import { AGENT_HOOK_TARGETS } from './agent-hook-types'

export const runtimeRpcStartErrorClassSchema = z.enum([
  'permission_denied',
  'address_in_use',
  'storage_unavailable',
  'invalid_path',
  'unknown'
])
export type RuntimeRpcStartErrorClass = z.infer<typeof runtimeRpcStartErrorClassSchema>
export const hookInstallAgentSchema = z.enum(AGENT_HOOK_TARGETS)
export type HookInstallAgent = z.infer<typeof hookInstallAgentSchema>
