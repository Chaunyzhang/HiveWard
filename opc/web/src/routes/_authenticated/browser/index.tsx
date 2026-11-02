import { createFileRoute } from '@tanstack/react-router'
import { Browser } from '@/features/browser'

export const Route = createFileRoute('/_authenticated/browser/')({
  component: Browser,
})
