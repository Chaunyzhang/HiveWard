import { useEffect, useState } from 'react'
import type { AgentStatus } from '@/lib/opc-format'

/**
 * 「干活」要连续几秒没再看到才算停下：Kimi 等不报状态的 Agent 靠屏幕上的转圈判断，
 * 两步之间转圈会消失一下，不压住的话状态和扫光会一闪一闪。变成干活、等待、故障都立刻生效。
 */
export function useSettledStatus<T extends AgentStatus | undefined>(
  status: T,
  holdMs = 4000
): T | 'working' {
  const working = status === 'working'
  const [prev, setPrev] = useState(working)
  // 刚从干活变成不干活：先压住
  const [holding, setHolding] = useState(false)
  if (working !== prev) {
    setPrev(working)
    setHolding(!working)
  }
  useEffect(() => {
    if (!holding) {
      return
    }
    const t = setTimeout(() => setHolding(false), holdMs)
    return () => clearTimeout(t)
  }, [holding, holdMs])
  return holding && (status === 'idle' || status === undefined)
    ? 'working'
    : status
}
