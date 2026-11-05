import { createFileRoute } from '@tanstack/react-router'
import { MachineTransferPage } from '@/features/machines/transfer'

export const Route = createFileRoute('/_authenticated/machines/$machineId')({
  component: function MachineRoute() {
    const { machineId } = Route.useParams()
    return <MachineTransferPage machineId={machineId} />
  },
})
