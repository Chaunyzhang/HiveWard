import { createFileRoute } from '@tanstack/react-router'
import { SettingsRoute } from '@/features/settings'

export const Route = createFileRoute('/_authenticated/settings')({
  component: SettingsRoute,
})
