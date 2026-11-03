import { createFileRoute } from '@tanstack/react-router'
import { Workbench } from '@/features/workbench'

export const Route = createFileRoute('/_authenticated/topology/')({
  component: function TopologyRoute() {
    return <Workbench tab='topology' />
  },
})
