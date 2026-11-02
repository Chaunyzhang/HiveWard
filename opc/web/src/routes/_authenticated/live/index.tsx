import { createFileRoute } from '@tanstack/react-router'
import { Live } from '@/features/live'

export const Route = createFileRoute('/_authenticated/live/')({
  component: Live,
})
