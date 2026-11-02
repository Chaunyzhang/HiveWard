import { createFileRoute } from '@tanstack/react-router'
import { Timeline } from '@/features/timeline'

export const Route = createFileRoute('/_authenticated/timeline/')({
  component: Timeline,
})
