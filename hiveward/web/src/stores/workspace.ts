import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 右栏一次看一样：更改 / 浏览器 / 文件 / 后台任务 / 计划 / 侧边对话 */
export type SideTab =
  | 'changes'
  | 'browser'
  | 'files'
  | 'tasks'
  | 'plan'
  | 'chat'

/** 中间栏打开的会话：右栏的更改、计划、后台任务都跟着它 */
export type FocusedSession = {
  /** 架构图节点 id */
  nodeId: string
  /** 在哪台电脑上；null 为本机 */
  machine: string | null
  /** 中间栏取架构图的范围：业务页是那块业务，集团首页为空 */
  scope?: string
  /** 直连的终端 */
  handle?: string
  /** 会话的工作目录 */
  dir?: string
  /** 从本机架构图上的远程下属点开的：本机那张卡（左栏按它显示选中），上面几项都是执行端那台电脑的 */
  via?: { nodeId: string; machine: string | null }
}

/**
 * 三栏布局共用的状态：
 * - 左栏开没开、哪些业务 / 项目展开了（记住，重开 App 还在）；
 * - 右栏开没开、在看哪一样、宽度（记住）；
 * - 中间栏现在点开的是哪个会话、哪个终端；右栏浏览器只显示它开的网页（不记）。
 */
type WorkspaceState = {
  /** 左栏（会话栏）开着 */
  railOpen: boolean
  setRailOpen: (open: boolean) => void
  /** 业务展开了没（不在表里是收着） */
  expanded: Record<string, boolean>
  toggleExpanded: (businessId: string, open?: boolean) => void
  /** 项目收起了没（不在表里是展开） */
  projectsClosed: Record<string, boolean>
  toggleProject: (key: string) => void
  /** 全部收起 / 全部展开：业务和项目一起 */
  setAllExpanded: (
    open: boolean,
    keys: { businesses: string[]; projects: string[] }
  ) => void
  /** 左栏「业务」整块收起 */
  businessesClosed: boolean
  toggleBusinesses: () => void
  sideOpen: boolean
  setSideOpen: (open: boolean) => void
  sideTab: SideTab
  setSideTab: (tab: SideTab) => void
  /** 点工具栏按钮：没开或在看别的就切过去，正在看这一样就收起 */
  toggleSide: (tab: SideTab) => void
  /** 右栏宽度（px），拖左边缘改 */
  sideWidth: number
  setSideWidth: (width: number) => void
  agent: string | null
  setAgent: (handle: string | null) => void
  session: FocusedSession | null
  setSession: (session: FocusedSession | null) => void
  /** 侧边对话开的是哪个终端（不记） */
  sideChat: string | null
  setSideChat: (handle: string | null) => void
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      railOpen: true,
      setRailOpen: (railOpen) => set({ railOpen }),
      expanded: {},
      toggleExpanded: (id, open) =>
        set((s) => ({
          expanded: { ...s.expanded, [id]: open ?? !s.expanded[id] },
        })),
      projectsClosed: {},
      toggleProject: (key) =>
        set((s) => ({
          projectsClosed: {
            ...s.projectsClosed,
            [key]: !s.projectsClosed[key],
          },
        })),
      setAllExpanded: (open, keys) =>
        set((s) => ({
          expanded: {
            ...s.expanded,
            ...Object.fromEntries(keys.businesses.map((k) => [k, open])),
          },
          projectsClosed: {
            ...s.projectsClosed,
            ...Object.fromEntries(keys.projects.map((k) => [k, !open])),
          },
        })),
      businessesClosed: false,
      toggleBusinesses: () =>
        set((s) => ({ businessesClosed: !s.businessesClosed })),
      sideOpen: true,
      setSideOpen: (sideOpen) => set({ sideOpen }),
      sideTab: 'files',
      setSideTab: (sideTab) => set({ sideTab }),
      toggleSide: (tab) =>
        set((s) =>
          s.sideOpen && s.sideTab === tab
            ? { sideOpen: false }
            : { sideOpen: true, sideTab: tab }
        ),
      sideWidth: 400,
      setSideWidth: (sideWidth) =>
        set({ sideWidth: Math.round(Math.min(960, Math.max(300, sideWidth))) }),
      agent: null,
      setAgent: (agent) => set({ agent }),
      session: null,
      setSession: (session) => set({ session }),
      sideChat: null,
      setSideChat: (sideChat) => set({ sideChat }),
    }),
    {
      name: 'hiveward.workspace',
      partialize: (s) => ({
        railOpen: s.railOpen,
        expanded: s.expanded,
        projectsClosed: s.projectsClosed,
        businessesClosed: s.businessesClosed,
        sideOpen: s.sideOpen,
        sideTab: s.sideTab,
        sideWidth: s.sideWidth,
      }),
    }
  )
)
