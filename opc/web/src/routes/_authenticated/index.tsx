import z from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { Workbench } from '@/features/workbench'

export const Route = createFileRoute('/_authenticated/')({
  validateSearch: z.object({
    /** 集团总览的标签：概览（默认）/ 架构图 / 任务 */
    tab: z.enum(['overview', 'topology', 'tasks']).optional().catch(undefined),
  }),
  component: function HomeRoute() {
    const { tab } = Route.useSearch()
    return <Workbench tab={tab} />
  },
})
