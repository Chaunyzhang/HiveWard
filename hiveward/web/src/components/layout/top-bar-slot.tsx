import { createContext, useContext } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { cn } from '@/lib/utils'

/**
 * 像 Claude 桌面端那样只有一排顶栏：中间栏打开会话时，会话的标题行（名字、状态、对话 / 终端、工具栏）
 * 不再自己占一行，而是挂进顶栏中间那一格。顶栏放一个空格子，会话往里面送。
 */
const useSlot = create<{
  el: HTMLElement | null
  set: (el: HTMLElement | null) => void
}>((set) => ({ el: null, set: (el) => set({ el }) }))

/** 顶栏中间的空格子 */
export function TopBarSlot({ className }: { className?: string }) {
  const set = useSlot((s) => s.set)
  return <div ref={set} className={cn('flex min-w-0 flex-1', className)} />
}

/** 这块界面的标题行挂进顶栏（中间栏的主会话里为 true；抽屉、侧边对话里为 false） */
export const DockedContext = createContext(false)

export const useDocked = () => useContext(DockedContext)

/**
 * 标题行：挂进顶栏时送进顶栏的格子，否则照旧自己占一行。
 * className 只管里面的排法（间距），高度、边线由这里统一。
 */
export function PaneHeader({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  const docked = useDocked()
  const el = useSlot((s) => s.el)
  if (docked) {
    return el
      ? createPortal(
          <div className={cn('flex min-w-0 flex-1 items-center', className)}>
            {children}
          </div>,
          el
        )
      : null
  }
  return (
    <header
      className={cn('flex h-12 shrink-0 items-center border-b px-4', className)}
    >
      {children}
    </header>
  )
}
