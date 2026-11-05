import z from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { Workbench } from '@/features/workbench'

export const Route = createFileRoute('/_authenticated/')({
  validateSearch: z.object({
    /** 中间栏打开的会话（架构图节点 id）；不在业务里的终端是 hiveward:<handle> */
    session: z.string().optional().catch(undefined),
    /** 会话在哪台电脑上；不填是本机 */
    m: z.string().optional().catch(undefined),
  }),
  component: function HomeRoute() {
    const { session, m } = Route.useSearch()
    return (
      <Workbench
        tab='topology'
        session={session ? { id: session, machine: m ?? null } : undefined}
      />
    )
  },
})
