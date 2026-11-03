import { createFileRoute } from '@tanstack/react-router'
import { Workbench } from '@/features/workbench'

export const Route = createFileRoute('/_authenticated/')({
  component: function HomeRoute() {
    return <Workbench />
  },
})
