import z from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { Workbench } from '@/features/workbench'

export const Route = createFileRoute('/_authenticated/b/$businessId')({
  validateSearch: z.object({
    objective: z.string().optional().catch(undefined),
    /** 看业务里的哪个项目；不填看整块业务 */
    project: z.string().optional().catch(undefined),
    /** 主页的标签：概览（默认）/ 架构图 / 任务 / 待办 / 现场 / 时间线 */
    tab: z
      .enum(['overview', 'topology', 'tasks', 'decisions', 'live', 'timeline'])
      .optional()
      .catch(undefined),
    /** 现场标签里选中的终端 handle */
    t: z.string().optional().catch(undefined),
  }),
  component: function BusinessRoute() {
    const { businessId } = Route.useParams()
    const { project, tab, t } = Route.useSearch()
    return (
      <Workbench
        key={`${businessId}/${project ?? ''}`}
        businessId={businessId}
        projectId={project}
        tab={tab}
        terminal={t}
      />
    )
  },
})
