import z from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { Workbench } from '@/features/workbench'

export const Route = createFileRoute('/_authenticated/tasks/')({
  validateSearch: z.object({
    /** 只看某块业务的任务 */
    business: z.string().optional().catch(undefined),
    /** 只看这块业务里某个项目的任务 */
    project: z.string().optional().catch(undefined),
    /** 按状态筛；不填是全部（时间线） */
    status: z
      .enum(['active', 'mine', 'review', 'done', 'failed'])
      .optional()
      .catch(undefined),
  }),
  component: function TasksRoute() {
    const { business, project, status } = Route.useSearch()
    return (
      <Workbench
        tab='tasks'
        status={status}
        taskFilter={{ businessId: business, projectId: project }}
      />
    )
  },
})
