import { createFileRoute } from '@tanstack/react-router'
import { Files } from '@/features/files'

export const Route = createFileRoute('/_authenticated/files/')({
  component: Files,
})
