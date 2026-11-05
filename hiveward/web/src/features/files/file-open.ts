import { create } from 'zustand'
import { useWorkspace } from '@/stores/workspace'

/**
 * 别处（对话里 Agent 提到的路径、Agent 的 hiwd file open）要在右栏文件查看器里打开一个文件：
 * 记下请求，切到右栏「文件」；文件面板收到后按它的根目录解析相对路径，打开查看器，再把请求清掉。
 * 眼下的页面没有目录（集团页面）时，右栏用 fallbackRoot：最近一次 Agent 打开的文件所在目录。
 */
type OpenRequest = { path: string; at: number }

export const useFileOpen = create<{
  request: OpenRequest | null
  fallbackRoot: string | null
  clear: () => void
}>()((set) => ({
  request: null,
  fallbackRoot: null,
  clear: () => set({ request: null }),
}))

const parentDir = (path: string) =>
  path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') || '/'

export function openInViewer(path: string, opts?: { fallbackRoot?: boolean }) {
  useFileOpen.setState({
    request: { path, at: Date.now() },
    ...(opts?.fallbackRoot ? { fallbackRoot: parentDir(path) } : {}),
  })
  const ws = useWorkspace.getState()
  ws.setSideTab('files')
  ws.setSideOpen(true)
}
