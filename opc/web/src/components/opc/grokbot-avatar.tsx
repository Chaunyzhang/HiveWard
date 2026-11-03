import { cn } from '@/lib/utils'
import {
  grokBotShape,
  type GrokBotLook,
  type GrokBotMood,
} from './grokbot-shape'

/** 一个 Grok Bot 的头像。look 给了就照它画，没给按 seed（Bot id）推默认形象 */
export function GrokBotAvatar({
  seed,
  look,
  mood = 'idle',
  animate = false,
  className,
}: {
  seed: string
  look?: GrokBotLook
  mood?: GrokBotMood
  animate?: boolean
  className?: string
}) {
  return (
    <svg
      viewBox='0 0 24 24'
      role='img'
      aria-label='Grok Bot'
      className={cn('size-4 shrink-0 overflow-visible', className)}
    >
      {grokBotShape(look ?? seed, mood, animate)}
    </svg>
  )
}
