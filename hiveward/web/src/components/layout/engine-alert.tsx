import { CircleAlert } from 'lucide-react'
import { useHiveWardStatus } from '@/hooks/use-hiveward-status'
import { useSettings } from '@/features/settings'

/** 引擎出问题时顶栏右边的小红提示，点开设置看详情；正常（含连接中）时不占位置 */
export function EngineAlert() {
  const { tone, label, hint } = useHiveWardStatus()
  const show = useSettings((s) => s.show)
  if (tone === 'ok' || tone === 'idle') {
    return null
  }
  return (
    <button
      type='button'
      title={hint}
      onClick={() => show('general')}
      className='ms-1 flex h-7 max-w-48 shrink-0 items-center gap-1.5 rounded-md bg-danger/10 px-2 text-xs whitespace-nowrap text-danger transition-colors hover:bg-danger/15'
    >
      <CircleAlert className='size-3.5 shrink-0' />
      <span className='truncate'>{label}</span>
    </button>
  )
}
