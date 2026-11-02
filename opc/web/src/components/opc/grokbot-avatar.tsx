import { cn } from '@/lib/utils'
import { grokBotShape, type GrokBotMood } from './grokbot-shape'

export function GrokBotAvatar({
  seed,
  mood = 'idle',
  className,
}: {
  seed: string
  mood?: GrokBotMood
  className?: string
}) {
  return (
    <svg
      viewBox='0 0 24 24'
      role='img'
      aria-label='Grok Bot'
      className={cn('size-4 shrink-0', className)}
    >
      {grokBotShape(seed, mood)}
    </svg>
  )
}
