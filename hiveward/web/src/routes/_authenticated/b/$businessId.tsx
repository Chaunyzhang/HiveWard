import z from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { Workbench } from '@/features/workbench'

export const Route = createFileRoute('/_authenticated/b/$businessId')({
  validateSearch: z.object({
    objective: z.string().optional().catch(undefined),
    /** 看业务里的哪个项目；不填看整块业务 */
    project: z.string().optional().catch(undefined),
    /** 主页的标签：架构图（默认）/ 任务 / 现场 */
    tab: z.enum(['topology', 'tasks', 'live']).optional().catch(undefined),
    /** 任务标签按状态筛；不填是全部（时间线） */
    status: z
      .enum(['active', 'mine', 'review', 'done', 'failed'])
      .optional()
      .catch(undefined),
    /** 现场标签里选中的终端 handle */
    t: z.string().optional().catch(undefined),
    /** 中间栏打开的会话（架构图节点 id） */
    session: z.string().optional().catch(undefined),
    /** 会话在哪台电脑上；不填是正在看的那台 */
    m: z.string().optional().catch(undefined),
  }),
  component: function BusinessRoute() {
    const { businessId } = Route.useParams()
    const { project, tab, t, status, session, m } = Route.useSearch()
    return (
      <Workbench
        key={`${businessId}/${project ?? ''}`}
        businessId={businessId}
        projectId={project}
        tab={tab}
        terminal={t}
        status={status}
        session={session ? { id: session, machine: m ?? null } : undefined}
      />
    )
  },
})
