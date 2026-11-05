import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ChooseMenuRequest,
  ChooseMenuResponse,
  HiveWardChat,
  HiveWardCreateTerminalRequest,
  HiveWardProject,
  HiveWardScreen,
  HiveWardImageUpload,
  HiveWardSendRequest,
  HiveWardTerminal,
  QuotaResponse,
  WorkerCloseResponse,
  WorkerCloseUndoResponse,
} from '@shared/api'
import { tr } from '@/lib/i18n'
import { scoped, useMachineId } from './machine'

// 现场页只走真实数据：经 vite 代理到本机 server/hiveward-bridge.mjs，不走模拟。
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
    throw new Error(
      tr('连不上 HiveWard 后台（node server/hiveward-bridge.mjs）')
    )
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 502 && !body) {
      throw new Error(
        tr('HiveWard 后台没启动（node server/hiveward-bridge.mjs）')
      )
    }
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  }
  return body as T
}

const enc = encodeURIComponent

export const terminalsQuery = (m: string | null) => ({
  queryKey: ['hiveward', 'terminals', m],
  queryFn: () =>
    live<{ terminals: HiveWardTerminal[] }>(
      '/api/hiveward/terminals',
      undefined,
      m
    ).then((r) => r.terminals),
  refetchInterval: 3_000,
  retry: false,
})

export function useHiveWardTerminals() {
  return useQuery(terminalsQuery(useMachineId()))
}

export function useHiveWardProjects() {
  const m = useMachineId()
  return useQuery({
    queryKey: ['hiveward', 'projects', m],
    queryFn: () =>
      live<{ projects: HiveWardProject[] }>(
        '/api/hiveward/projects',
        undefined,
        m
      ).then((r) => r.projects),
    staleTime: 60_000,
    retry: false,
  })
}

/** 每秒读一次整屏：HiveWard 的逐字流只开在需配对的 websocket 上，这里用整屏轮询代替。 */
export function useHiveWardScreen(handle: string | null) {
  const m = useMachineId()
  return useQuery({
    queryKey: ['hiveward', 'screen', handle, m],
    enabled: !!handle,
    queryFn: () =>
      live<HiveWardScreen>(
        `/api/hiveward/terminals/${enc(handle!)}/screen`,
        undefined,
        m
      ),
    refetchInterval: 1_000,
    retry: false,
  })
}

/** 对话视图：Agent 自己的对话记录，后端按字节增量读，这里每秒拉一次。 */
export function useHiveWardChat(handle: string | null) {
  const m = useMachineId()
  return useQuery({
    queryKey: ['hiveward', 'chat', handle, m],
    enabled: !!handle,
    queryFn: () =>
      live<HiveWardChat>(
        `/api/hiveward/terminals/${enc(handle!)}/chat`,
        undefined,
        m
      ),
    refetchInterval: 1_000,
    retry: false,
  })
}

/** 坐在 CEO / Leader 位上的外部会话（Claude 桌面端等）的对话：只读，按架构图节点 id 取 */
export function useSeatChat(nodeId: string | null) {
  const m = useMachineId()
  return useQuery({
    queryKey: ['seat', 'chat', nodeId, m],
    enabled: !!nodeId,
    queryFn: () =>
      live<HiveWardChat>(`/api/seats/${enc(nodeId!)}/chat`, undefined, m),
    refetchInterval: 2_000,
    retry: false,
  })
}

export function useHiveWardSend(handle: string | null) {
  const qc = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (body: HiveWardSendRequest) =>
      live(
        `/api/hiveward/terminals/${enc(handle!)}/send`,
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hiveward', 'screen', handle, m] })
      qc.invalidateQueries({ queryKey: ['hiveward', 'chat', handle, m] })
    },
  })
}

/** 对话框里贴的一张图：存到那台电脑上，拿回路径，发送时带上 */
export function useHiveWardImageUpload() {
  const m = useMachineId()
  return (file: Blob) =>
    live<HiveWardImageUpload>(
      '/api/hiveward/images',
      { method: 'POST', body: file, headers: { 'content-type': file.type } },
      m
    ).then((r) => r.path)
}

/** 选终端菜单的第 n 项（桥先确认菜单还在再按键） */
export function useHiveWardChoose(handle: string) {
  const qc = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (choice: ChooseMenuRequest) =>
      live<ChooseMenuResponse>(
        `/api/hiveward/terminals/${enc(handle)}/choose`,
        {
          method: 'POST',
          body: JSON.stringify(choice satisfies ChooseMenuRequest),
        },
        m
      ),
    // 终端画面、架构图、待办都跟着变
    onSuccess: () => qc.invalidateQueries(),
  })
}

export function useHiveWardCreate() {
  const qc = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (body: HiveWardCreateTerminalRequest) =>
      live<{ handle: string }>(
        '/api/hiveward/terminals',
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['hiveward', 'terminals'] }),
  })
}

export function useHiveWardClose() {
  const qc = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (handle: string) =>
      live(
        `/api/hiveward/terminals/${enc(handle)}/close`,
        { method: 'POST' },
        m
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['hiveward', 'terminals'] }),
  })
}

/** 关下属：后台过 5 秒才真关，这段时间里架构图、终端列表先把它藏起来。不是 hook：点的那张卡关完就没了 */
export const closeWorker = (handle: string, machine: string | null) =>
  live<WorkerCloseResponse>(
    `/api/workers/${enc(handle)}/close`,
    { method: 'POST' },
    machine
  )

/** 撤销关下属（5 秒内）；已经关掉了 undone 为 false。不是 hook：提示条比点 × 的那一行活得久 */
export const undoCloseWorker = (handle: string, machine: string | null) =>
  live<WorkerCloseUndoResponse>(
    `/api/workers/${enc(handle)}/close/undo`,
    { method: 'POST' },
    machine
  )

export const quotaQuery = (m: string | null) => ({
  queryKey: ['quota', m],
  queryFn: () => live<QuotaResponse>('/api/quota', undefined, m),
  refetchInterval: 30_000,
  retry: false,
})

/** 哪家额度用完、大约几点恢复、几个下属因此停着；后台旧版本没有这个接口时为空 */
export function useQuota() {
  return useQuery(quotaQuery(useMachineId()))
}
