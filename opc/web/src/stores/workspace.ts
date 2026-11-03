import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SideTab = 'files' | 'browser'

/**
 * 三栏布局共用的状态：
 * - 左栏哪些业务展开了（记住，重开 App 还在）；
 * - 右栏开没开、在看文件还是浏览器（记住）；
 * - 中间栏现在点开的是哪个 Agent（终端 handle），右栏浏览器只显示它开的网页（不记）。
 */
type WorkspaceState = {
  expanded: Record<string, boolean>
  toggleExpanded: (businessId: string, open?: boolean) => void
  /** 左栏「业务」整块收起 */
  businessesClosed: boolean
  toggleBusinesses: () => void
  sideOpen: boolean
  setSideOpen: (open: boolean) => void
  sideTab: SideTab
  setSideTab: (tab: SideTab) => void
  /** 右栏宽度（px），拖左边缘改 */
  sideWidth: number
  setSideWidth: (width: number) => void
  agent: string | null
  setAgent: (handle: string | null) => void
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      expanded: {},
      toggleExpanded: (id, open) =>
        set((s) => ({
          expanded: { ...s.expanded, [id]: open ?? !s.expanded[id] },
        })),
      businessesClosed: false,
      toggleBusinesses: () =>
        set((s) => ({ businessesClosed: !s.businessesClosed })),
      sideOpen: true,
      setSideOpen: (sideOpen) => set({ sideOpen }),
      sideTab: 'files',
      setSideTab: (sideTab) => set({ sideTab }),
      sideWidth: 400,
      setSideWidth: (sideWidth) =>
        set({ sideWidth: Math.round(Math.min(960, Math.max(300, sideWidth))) }),
      agent: null,
      setAgent: (agent) => set({ agent }),
    }),
    {
      name: 'hiveward.workspace',
      partialize: (s) => ({
        expanded: s.expanded,
        businessesClosed: s.businessesClosed,
        sideOpen: s.sideOpen,
        sideTab: s.sideTab,
        sideWidth: s.sideWidth,
      }),
    }
  )
)
