import { createFileRoute } from '@tanstack/react-router'
import { SettingsMachine } from '@/features/settings/machine'

export const Route = createFileRoute('/_authenticated/settings/machine')({
  component: SettingsMachine,
})
