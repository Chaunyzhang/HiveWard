import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  mockBusinessDetail,
  mockDecisions,
  mockLeaderScreen,
  mockOverview,
  mockResolveDecision,
  mockTasks,
  mockTopology,
  mockWorkerScreen,
} from '@/mocks/data'
import type {
  BusinessDetailResponse,
  BusinessSummary,
  CreateProjectRequest,
  Decision,
  LeaderScreenResponse,
  OverviewResponse,
  ResolveDecisionRequest,
  Task,
  TopologyResponse,
  UpdateProjectRequest,
} from '@shared/api'
import { scoped, useMachineId } from './machine'

// 默认走真实 /api（vite 代理到本机 server/orca-bridge.mjs）；设置 VITE_API_MOCK=true 改看模拟数据。
const USE_MOCK = import.meta.env.VITE_API_MOCK === 'true'

const delay = () => new Promise((r) => setTimeout(r, 150))

async function request<T>(
  path: string,
  mock: () => T | null,
  init?: RequestInit,
  machine?: string | null
): Promise<T> {
  if (USE_MOCK) {
    await delay()
    const data = mock()
    if (data === null) throw new Error('not_found')
    // 模拟数据会被就地修改，克隆一份，避免查询缓存认为"没变化"
    return structuredClone(data)
  }
  const res = await fetch(scoped(path, machine), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

const qs = (params: Record<string, string | undefined>) => {
  const entries = Object.entries(params).filter(
    (e): e is [string, string] => e[1] !== undefined
  )
  return entries.length ? `?${new URLSearchParams(entries)}` : ''
}

const POLL = 5_000

/*
 * 查询参数单独导出：首页把几台电脑合在一起看时，用 useQueries 同时取每台的数据，
 * 和各处 useXxx() 用的是同一份缓存（m 为 null 是本机，否则是那台电脑的 id）。
 */
export const overviewQuery = (m: string | null) => ({
  queryKey: ['overview', m],
  queryFn: () =>
    request<OverviewResponse>('/api/overview', mockOverview, undefined, m),
  refetchInterval: POLL,
})

export const decisionsQuery = (m: string | null) => ({
  queryKey: ['decisions', m],
  queryFn: () =>
    request<Decision[]>(
      '/api/decisions?state=pending',
      mockDecisions,
      undefined,
      m
    ),
  refetchInterval: POLL,
})

export const tasksQuery = (m: string | null, businessId?: string) => ({
  queryKey: ['tasks', businessId ?? 'all', m],
  queryFn: () =>
    request<Task[]>(
      `/api/tasks${qs({ businessId })}`,
      () => mockTasks(businessId),
      undefined,
      m
    ),
  refetchInterval: POLL,
})

export const topologyQuery = (m: string | null, businessId?: string) => ({
  queryKey: ['topology', businessId ?? 'company', m],
  queryFn: () =>
    request<TopologyResponse>(
      `/api/topology${qs({ businessId })}`,
      () => mockTopology(businessId),
      undefined,
      m
    ),
  refetchInterval: POLL,
})

export function useOverview() {
  return useQuery(overviewQuery(useMachineId()))
}

export function useBusinessDetail(id: string) {
  const m = useMachineId()
  return useQuery({
    queryKey: ['business', id, m],
    queryFn: () =>
      request<BusinessDetailResponse>(
        `/api/businesses/${encodeURIComponent(id)}`,
        () => mockBusinessDetail(id),
        undefined,
        m
      ),
    refetchInterval: POLL,
  })
}

export function useDecisions() {
  return useQuery(decisionsQuery(useMachineId()))
}

export function useTasks(businessId?: string) {
  return useQuery(tasksQuery(useMachineId(), businessId))
}

export function useTopology(businessId?: string) {
  return useQuery(topologyQuery(useMachineId(), businessId))
}

/** 负责人或下属的终端当前画面（只在详情打开时轮询）。 */
export function useAgentScreen(
  target:
    | { kind: 'leader'; businessId: string }
    | { kind: 'worker'; dispatchId: string }
    | null
) {
  const m = useMachineId()
  return useQuery({
    queryKey: ['screen', target, m],
    enabled: !!target,
    queryFn: () => {
      const t = target!
      if (t.kind === 'leader') {
        const id = t.businessId
        return request<LeaderScreenResponse>(
          `/api/businesses/${encodeURIComponent(id)}/leader/screen`,
          () => mockLeaderScreen(id),
          undefined,
          m
        )
      }
      const id = t.dispatchId
      return request<LeaderScreenResponse>(
        `/api/workers/${encodeURIComponent(id)}/screen`,
        () => mockWorkerScreen(id),
        undefined,
        m
      )
    },
    refetchInterval: 3_000,
  })
}

export function useResolveDecision() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: ({ id, ...body }: ResolveDecisionRequest & { id: string }) =>
      request<Decision>(
        `/api/decisions/${encodeURIComponent(id)}/resolve`,
        () => mockResolveDecision(id, body.choice, body.note, body.custom),
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 给业务派负责人：在业务目录开一个完全访问模式的负责人终端 */
export function useLaunchLeader() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (businessId: string) =>
      request<unknown>(
        `/api/businesses/${encodeURIComponent(businessId)}/leader`,
        () => {
          throw new Error('模拟数据下不能派负责人')
        },
        { method: 'POST' },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

const noMock = (what: string) => () => {
  throw new Error(`模拟数据下不能${what}`)
}

/** 加项目：目录登记成引擎里的项目，同时就是一块业务；目录已经是项目时返回那块业务 */
export function useAddProject() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (body: CreateProjectRequest) =>
      request<{ business: BusinessSummary }>(
        '/api/projects',
        noMock('加项目'),
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 改项目：改名会同时改引擎里项目的名字 */
export function useUpdateProject() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateProjectRequest & { id: string }) =>
      request<{ business: BusinessSummary }>(
        `/api/projects/${encodeURIComponent(id)}`,
        noMock('改项目'),
        { method: 'PATCH', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 移除项目：只是不再登记，磁盘上的目录和文件不动，任务记录保留 */
export function useRemoveProject() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (id: string) =>
      request<unknown>(
        `/api/projects/${encodeURIComponent(id)}`,
        noMock('移除项目'),
        { method: 'DELETE' },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}
