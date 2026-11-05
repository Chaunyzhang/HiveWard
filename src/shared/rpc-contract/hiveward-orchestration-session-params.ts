import { z } from 'zod'

export const HivewardDispatcher = z.object({
  kind: z.enum(['claude-desktop', 'claude-code', 'grok', 'cli', 'owner']),
  id: z.string().min(1),
  label: z.string().min(1),
  cwd: z.string().optional(),
  machineId: z.string().optional()
})
export const HivewardSessionRegisterParams = z.object({
  key: z.string().min(1).max(4096),
  dispatcher: HivewardDispatcher,
  path: z.string().min(1)
})
