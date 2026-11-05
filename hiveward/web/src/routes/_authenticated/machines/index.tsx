import { createFileRoute } from '@tanstack/react-router'
import { Machines } from '@/features/machines'

export const Route = createFileRoute('/_authenticated/machines/')({
  component: Machines,
})
