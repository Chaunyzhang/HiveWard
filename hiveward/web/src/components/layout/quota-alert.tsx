import { Hourglass } from 'lucide-react'
import { quotaText } from '@/lib/hiveward-format'
import { useQuota } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { useSettings } from '@/features/settings'

/** 某家 Agent 额度用完时顶栏右边的小提示，点开设置的用量页；没问题时不占位置 */
export function QuotaAlert() {
  const { data } = useQuota()
  const show = useSettings((s) => s.show)
  const out = data?.providers.filter((p) => p.exhausted) ?? []
  if (!out.length) {
    return null
  }
  const lines = out.map((p) =>
    [
      `${p.name} ${quotaText(p.resetsAt)}`,
      p.stopped > 0 && tr('（{0} 个下属停着）', [p.stopped]),
    ]
      .filter(Boolean)
      .join('')
  )
  return (
    <button
      type='button'
      title={[
        ...lines,
        data?.autoResume
          ? tr('恢复后会自动叫它们接着做')
          : tr('「额度恢复后自动继续」关着，恢复后要你自己叫它们'),
      ].join('\n')}
      onClick={() => show('usage')}
      className='ms-1 flex h-7 max-w-80 shrink-0 items-center gap-1.5 rounded-md border border-attention/40 px-2 text-xs whitespace-nowrap text-attention transition-colors hover:bg-attention/10'
    >
      <Hourglass className='size-3.5 shrink-0' />
      <span className='truncate'>
        {lines[0]}
        {out.length > 1 && tr(' 等 {0} 家', [out.length])}
      </span>
    </button>
  )
}
