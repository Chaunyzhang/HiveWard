import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/*
 * 各家 Agent 自己干活时的那个转圈，照它们原版的样子画，排在对话页「正在运行…」那一行最前面：
 * - claude（Claude Code）：橙色的 ·✢✳✶✻✽ 来回变；
 * - claude-desktop（Claude 桌面端）：橙色 2×2 四个点轮流亮；
 * - codex：一个一呼一吸的圆点；
 * - kimi（Kimi Code）：蓝色的盲文点转圈；
 * - 其余：灰色的盲文点转圈。
 * 外框统一 1em 见方，和后面的字一样高。
 */
const CLAUDE = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function useFrame(count: number, ms: number) {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % count), ms)
    return () => clearInterval(t)
  }, [count, ms])
  return i
}

function Glyphs({
  frames,
  ms,
  className,
}: {
  frames: string[]
  ms: number
  className?: string
}) {
  const i = useFrame(frames.length, ms)
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid size-[1em] shrink-0 place-items-center leading-none',
        className
      )}
    >
      {frames[i]}
    </span>
  )
}

function Dots() {
  const i = useFrame(4, 220)
  // 顺时针：左上、右上、右下、左下
  const order = [0, 1, 3, 2]
  return (
    <span
      aria-hidden
      className='inline-grid size-[1em] shrink-0 grid-cols-2 place-items-center p-[0.12em]'
    >
      {[0, 1, 2, 3].map((d) => (
        <span
          key={d}
          className={cn(
            'size-[0.28em] rounded-full bg-[#D97757] transition-opacity duration-200',
            order[i] === d ? 'opacity-100' : 'opacity-30'
          )}
        />
      ))}
    </span>
  )
}

export function AgentSpinner({
  agent,
  className,
}: {
  agent?: string | null
  className?: string
}) {
  switch (agent ?? '') {
    case 'claude':
      return (
        <Glyphs
          frames={CLAUDE}
          ms={120}
          className={cn('text-[#D97757]', className)}
        />
      )
    case 'claude-desktop':
      return (
        <span className={cn('inline-flex', className)}>
          <Dots />
        </span>
      )
    case 'codex':
      return (
        <span
          aria-hidden
          className={cn(
            'inline-grid size-[1em] shrink-0 place-items-center',
            className
          )}
        >
          <span className='size-[0.45em] animate-pulse rounded-full bg-foreground' />
        </span>
      )
    case 'kimi':
      return (
        <Glyphs
          frames={BRAILLE}
          ms={80}
          className={cn('text-[#1783FF]', className)}
        />
      )
    default:
      return (
        <Glyphs
          frames={BRAILLE}
          ms={80}
          className={cn('text-muted-foreground', className)}
        />
      )
  }
}
