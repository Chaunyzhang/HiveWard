import type { BusinessSummary } from '@shared/api'
import { toast } from 'sonner'
import { useLaunchCeo } from '@/lib/opc-api'
import { LEADER_LABEL, LEADERS } from '@/lib/opc-format'
import { AgentLogo } from '@/components/opc/agent-logo'
import { CopySeatPrompt } from './seat-prompt'

/**
 * CEO 位空着（或坐着的终端退出了）：主要用法是「复制提示词」，贴给老板正在用的 Agent，
 * 它照着执行 hiwd seat ceo 坐上来；也可以在这里选一家开终端坐上去。
 */
export function NoCeo({
  business,
  exited,
}: {
  business?: BusinessSummary
  exited: boolean
}) {
  const launch = useLaunchCeo()
  if (!business) {
    return (
      <p className='p-6 text-[13px] text-muted-foreground'>
        这块业务还没登记，没有 CEO 位。
      </p>
    )
  }
  return (
    <div className='flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted-foreground'>
      <p>
        「{business.name}」的 CEO 位
        {exited ? '上的 Agent 已经退出了。' : '空着。'}
      </p>
      <p className='max-w-md text-xs leading-5'>
        复制提示词，贴给你正在用的 Agent（Claude Code / Codex 会话），
        它会照着坐上来——哪台电脑、哪块业务、怎么坐，提示词里都写清楚了。
      </p>
      <CopySeatPrompt business={business} />
      <p className='mt-3 text-xs'>或者在这里开一个终端坐上去：</p>
      <div className='flex gap-2'>
        {LEADERS.map((a) => (
          <button
            key={a}
            type='button'
            disabled={launch.isPending}
            onClick={() =>
              launch.mutate(
                { businessId: business.id, agent: a, replace: exited },
                {
                  onSuccess: () =>
                    toast.success('CEO Agent 已开，稍等它出现在架构图里'),
                  onError: (e) => toast.error(`没开成：${e.message}`),
                }
              )
            }
            className='flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs text-foreground hover:bg-accent disabled:opacity-40'
          >
            <AgentLogo agent={a} className='size-3.5' />
            {LEADER_LABEL[a]}
          </button>
        ))}
      </div>
    </div>
  )
}
