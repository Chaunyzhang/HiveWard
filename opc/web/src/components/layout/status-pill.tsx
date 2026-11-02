import { cn } from '@/lib/utils'
import { useOrcaStatus } from '@/hooks/use-orca-status'

const dot = {
  ok: 'bg-live',
  warn: 'bg-attention',
  error: 'bg-danger',
  idle: 'bg-muted-foreground/50',
}

export function StatusPill() {
  const { tone, label, health } = useOrcaStatus()
  return (
    <span className='flex h-8 items-center gap-2 rounded-full border px-3 text-xs text-muted-foreground'>
      <span className={cn('size-1.5 rounded-full', dot[tone])} />
      <span>引擎</span>
      <span className='text-foreground'>{label}</span>
      {health?.appVersion && tone === 'ok' && (
        <span className='font-mono'>{health.appVersion}</span>
      )}
    </span>
  )
}
