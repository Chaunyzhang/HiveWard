import { z } from 'zod'

export const HivewardBrowserGateConsumeParams = z.object({
  terminal: z.string().min(1),
  gateId: z.string().min(1),
  question: z.string().min(1)
})
