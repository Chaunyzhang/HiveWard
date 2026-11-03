import { createFileRoute } from '@tanstack/react-router'
import { SettingsSharing } from '@/features/settings/sharing'

export const Route = createFileRoute('/_authenticated/settings/sharing')({
  component: SettingsSharing,
})
