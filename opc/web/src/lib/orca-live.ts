import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  OrcaChat,
  OrcaCreateTerminalRequest,
  OrcaProject,
  OrcaScreen,
  OrcaSendRequest,
  OrcaTerminal,
} from '@shared/api'
import { scoped, useMachineId } from './machine'

// 现场页只走真实数据：经 vite 代理到本机 server/orca-bridge.mjs，不走模拟。
async function live<T>(
  path: string,
  init?: RequestInit,
  machine?: string | null
): Promise<T> {
  let res: Response
  try {
    res = await fetch(scoped(path, machine), {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new Error('连不上 HiveWard 后台（node server/orca-bridge.mjs）')
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 502 && !body) {
      throw new Error('HiveWard 后台没启动（node server/orca-bridge.mjs）')
    }
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  }
  return body as T
}

const enc = encodeURIComponent

export const terminalsQuery = (m: string | null) => ({
  queryKey: ['orca', 'terminals', m],
  queryFn: () =>
    live<{ terminals: OrcaTerminal[] }>(
      '/api/orca/terminals',
      undefined,
      m
    ).then((r) => r.terminals),
  refetchInterval: 3_000,
  retry: false,
})

export function useOrcaTerminals() {
  return useQuery(terminalsQuery(useMachineId()))
}

export function useOrcaProjects() {
  const m = useMachineId()
  return useQuery({
    queryKey: ['orca', 'projects', m],
    queryFn: () =>
      live<{ projects: OrcaProject[] }>(
        '/api/orca/projects',
        undefined,
        m
      ).then((r) => r.projects),
    staleTime: 60_000,
    retry: false,
  })
}

/** 每秒读一次整屏：Orca 的逐字流只开在需配对的 websocket 上，这里用整屏轮询代替。 */
export function useOrcaScreen(handle: string | null) {
  const m = useMachineId()
  return useQuery({
    queryKey: ['orca', 'screen', handle, m],
    enabled: !!handle,
    queryFn: () =>
      live<OrcaScreen>(
        `/api/orca/terminals/${enc(handle!)}/screen`,
        undefined,
        m
      ),
    refetchInterval: 1_000,
    retry: false,
  })
}

/** 对话视图：Agent 自己的对话记录，后端按字节增量读，这里每秒拉一次。 */
export function useOrcaChat(handle: string | null) {
  const m = useMachineId()
  return useQuery({
    queryKey: ['orca', 'chat', handle, m],
    enabled: !!handle,
    queryFn: () =>
      live<OrcaChat>(`/api/orca/terminals/${enc(handle!)}/chat`, undefined, m),
    refetchInterval: 1_000,
    retry: false,
  })
}

export function useOrcaSend(handle: string | null) {
  const qc = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (body: OrcaSendRequest) =>
      live(
        `/api/orca/terminals/${enc(handle!)}/send`,
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orca', 'screen', handle, m] })
      qc.invalidateQueries({ queryKey: ['orca', 'chat', handle, m] })
    },
  })
}

export function useOrcaCreate() {
  const qc = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (body: OrcaCreateTerminalRequest) =>
      live<{ handle: string }>(
        '/api/orca/terminals',
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orca', 'terminals'] }),
  })
}

export function useOrcaClose() {
  const qc = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (handle: string) =>
      live(`/api/orca/terminals/${enc(handle)}/close`, { method: 'POST' }, m),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orca', 'terminals'] }),
  })
}
