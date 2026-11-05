import { useEffect, useState } from 'react'

/** 每隔 intervalMs 刷新一次的当前时间，用于"几秒前"和过期判断。 */
export function useNow(intervalMs = 1_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
