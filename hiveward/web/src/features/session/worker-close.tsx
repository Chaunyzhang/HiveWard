import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import type { TopologyNode } from '@shared/api'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { useWorkspace } from '@/stores/workspace'
import { closeWorker, undoCloseWorker } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { useMachineId } from '@/lib/machine'
import { cn } from '@/lib/utils'

/** 撤销提示留多久（和后台真关之前的等待一样长） */
const UNDO_MS = 5000

/**
 * 能在这里关的：下属、终端还开着、就在这台电脑上跑。
 * CEO / Leader / Personal Agent 不关；跨电脑的（派到别的电脑上执行的、别的电脑派来的）先不在这里关。
 */
export const closableWorker = (n: TopologyNode) =>
  n.kind === 'worker' &&
  !!n.terminal &&
  n.liveness !== 'exited' &&
  !n.execution &&
  !n.dispatcherMachineId &&
  !n.machineName

/**
 * 关下属：点一下就关（像关浏览器标签），底部出 5 秒「已关闭 · 撤销」。
 * 真正关终端在后台 5 秒后才做，撤销了就不关；对话记录照旧留着。
 * 正开着它的会话时，关了就回到打开它的地方。
 */
export function useCloseWorkerAction() {
  const qc = useQueryClient()
  const machine = useMachineId()
  const router = useRouter()
  return (n: TopologyNode) => {
    const handle = n.terminal
    if (!handle) {
      return
    }
    const refresh = () => void qc.invalidateQueries()
    closeWorker(handle, machine)
      .then(() => {
        const open = useWorkspace.getState().session
        if (open?.nodeId === n.id || open?.handle === handle) {
          router.history.back()
        }
        toast(tr('已关闭'), {
          description: tr('对话记录还留着'),
          duration: UNDO_MS,
          action: {
            label: tr('撤销'),
            onClick: () =>
              void undoCloseWorker(handle, machine)
                .then((r) => {
                  if (!r.undone) {
                    toast.warning(tr('来不及了，已经关掉了'))
                  }
                })
                .catch((e: Error) =>
                  toast.error(tr('没撤销成：{0}', [e.message]))
                )
                .finally(refresh),
          },
        })
        refresh()
      })
      .catch((e: Error) => toast.error(tr('没关掉：{0}', [e.message])))
  }
}

/** 下属的关闭按钮：会话顶栏常驻；左栏行、架构图卡片上悬停才出（父元素带 group/close） */
export function CloseWorkerButton({
  node,
  hover,
  className,
}: {
  node: TopologyNode
  /** 悬停才出现 */
  hover?: boolean
  className?: string
}) {
  const close = useCloseWorkerAction()
  if (!closableWorker(node)) {
    return null
  }
  return (
    <button
      type='button'
      title={tr('关闭这个下属')}
      aria-label={tr('关闭这个下属')}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        close(node)
      }}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5',
        hover && 'opacity-0 group-hover/close:opacity-100',
        className
      )}
    >
      <X />
    </button>
  )
}
