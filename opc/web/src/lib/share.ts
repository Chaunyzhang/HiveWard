import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ClipboardSettings,
  ClipboardStatus,
  FileShareSettings,
  McpShare,
  SaveMcpShareRequest,
} from '@shared/api'

/** 这台电脑共享什么（剪贴板同步、共享目录）：只读写本机，不跟着「正在看的电脑」走 */
async function self<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: (T & { error?: { message?: string } }) | null = await res
    .json()
    .catch(() => null)
  if (!res.ok || data === null) {
    throw new Error(
      res.status === 404 && !data?.error
        ? '后台还没有这个功能'
        : (data?.error?.message ?? `HTTP ${res.status}`)
    )
  }
  return data
}

export function useClipboardStatus() {
  return useQuery({
    queryKey: ['share', 'clipboard'],
    queryFn: () => self<ClipboardStatus>('/api/clipboard'),
    refetchInterval: 3_000,
    retry: false,
  })
}

export function useSetClipboard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (s: ClipboardSettings) =>
      self<ClipboardStatus>('/api/clipboard/settings', s),
    onSuccess: (data) => qc.setQueryData(['share', 'clipboard'], data),
  })
}

export function useFileShare() {
  return useQuery({
    queryKey: ['share', 'files'],
    queryFn: () => self<FileShareSettings>('/api/files/settings'),
    retry: false,
  })
}

export function useSetFileShare() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (s: FileShareSettings) =>
      self<FileShareSettings>('/api/files/settings', s),
    onSuccess: (data) => {
      qc.setQueryData(['share', 'files'], data)
      void qc.invalidateQueries({ queryKey: ['files'] })
    },
  })
}

/** 这台电脑共享出去的 MCP：只读写本机 */
export function useMcpShares() {
  return useQuery({
    queryKey: ['share', 'mcp'],
    queryFn: () => self<McpShare[]>('/api/mcp/shares'),
    refetchInterval: 5_000,
    retry: false,
  })
}

export function useSaveMcpShare() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (share: SaveMcpShareRequest) =>
      self<McpShare>('/api/mcp/shares', share),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['share', 'mcp'] }),
  })
}

export function useRemoveMcpShare() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) =>
      self<{ ok: true }>(
        `/api/mcp/shares/${encodeURIComponent(name)}/remove`,
        {}
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['share', 'mcp'] }),
  })
}
