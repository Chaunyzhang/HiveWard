import { z } from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { GoToPath } from '@/features/go'

export const Route = createFileRoute('/_authenticated/go')({
  validateSearch: z.object({ path: z.string(), t: z.string().optional() }),
  component: function Go() {
    return <GoToPath {...Route.useSearch()} />
  },
})
