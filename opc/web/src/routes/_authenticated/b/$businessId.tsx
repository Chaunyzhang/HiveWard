import z from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { Workbench } from '@/features/workbench'

export const Route = createFileRoute('/_authenticated/b/$businessId')({
  validateSearch: z.object({
    objective: z.string().optional().catch(undefined),
    /** 项目页的标签：概览（默认）/ 终端 */
    tab: z.enum(['overview', 'terminal']).optional().catch(undefined),
    /** 终端标签里选中的终端 handle */
    t: z.string().optional().catch(undefined),
  }),
  component: function BusinessRoute() {
    const { businessId } = Route.useParams()
    const { tab, t } = Route.useSearch()
    return (
      <Workbench
        key={businessId}
        businessId={businessId}
        tab={tab}
        terminal={t}
      />
    )
  },
})
