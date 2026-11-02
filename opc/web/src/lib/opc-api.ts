import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  mockBusinessDetail,
  mockDecisions,
  mockOverview,
  mockResolveDecision,
  mockTasks,
  mockTopology,
  mockWorkerScreen,
} from '@/mocks/data'
import type {
  BusinessDetailResponse,
  BusinessSummary,
  CreateBusinessProjectRequest,
  CreateBusinessProjectResponse,
  Decision,
  LaunchProjectLeaderRequest,
  LeaderScreenResponse,
  OverviewResponse,
  ResolveDecisionRequest,
  ResumeRecordResponse,
  ReviewTaskRequest,
  ReviewTaskResponse,
  Task,
  TopologyResponse,
  Project,
  RegisterBusinessRequest,
  UpdateBusinessProjectRequest,
  UpdateBusinessRequest,
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

/** 编排下属的终端当前画面（只在详情打开时轮询）。 */
export function useWorkerScreen(dispatchId: string | null) {
  const m = useMachineId()
  return useQuery({
    queryKey: ['screen', dispatchId, m],
    enabled: !!dispatchId,
    queryFn: () =>
      request<LeaderScreenResponse>(
        `/api/workers/${encodeURIComponent(dispatchId!)}/screen`,
        () => mockWorkerScreen(dispatchId!),
        undefined,
        m
      ),
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

const noMock = (what: string) => () => {
  throw new Error(`模拟数据下不能${what}`)
}

const businessPath = (id: string) => `/api/businesses/${encodeURIComponent(id)}`

/** 加业务：目录登记成引擎里的项目，同时就是一块业务；目录已经登记过时返回那块业务 */
export function useRegisterBusiness() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (body: RegisterBusinessRequest) =>
      request<{ business: BusinessSummary }>(
        '/api/businesses',
        noMock('加业务'),
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 改业务：改名会同时改引擎里项目的名字 */
export function useUpdateBusiness() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateBusinessRequest & { id: string }) =>
      request<{ business: BusinessSummary }>(
        businessPath(id),
        noMock('改业务'),
        { method: 'PATCH', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 移除业务：只是不再登记，磁盘上的目录和文件不动，任务记录保留 */
export function useRemoveBusiness() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (id: string) =>
      request<unknown>(
        businessPath(id),
        noMock('移除业务'),
        { method: 'DELETE' },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 在业务里新建项目；带 agent 就顺手开它的 Leader Agent */
export function useCreateProject(businessId: string) {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (body: CreateBusinessProjectRequest) =>
      request<CreateBusinessProjectResponse>(
        `${businessPath(businessId)}/projects`,
        noMock('建项目'),
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 改项目名、归档 / 恢复 */
export function useUpdateProject() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: ({
      project: p,
      ...body
    }: UpdateBusinessProjectRequest & { project: Project }) =>
      request<{ project: Project }>(
        `${businessPath(p.businessId)}/projects/${encodeURIComponent(p.id)}`,
        noMock('改项目'),
        { method: 'PATCH', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 给项目开 Leader Agent（已有活着的就把话发给它；replace 另开一个顶替） */
export function useLaunchProjectLeader() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: ({
      project: p,
      ...body
    }: LaunchProjectLeaderRequest & { project: Project }) =>
      request<{ project: Project; terminal: string }>(
        `${businessPath(p.businessId)}/projects/${encodeURIComponent(p.id)}/leader`,
        noMock('开 Leader Agent'),
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 复核一条派单：通过 → 关掉它的终端、留一条工作记录；打回 → 意见发回它的终端接着改 */
export function useReviewTask() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: ({ id, ...body }: ReviewTaskRequest & { id: string }) =>
      request<ReviewTaskResponse>(
        `/api/tasks/${encodeURIComponent(id)}/review`,
        noMock('复核'),
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 工作记录重新打开：在原目录开新终端接上原来的会话 */
export function useResumeRecord() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (id: string) =>
      request<ResumeRecordResponse>(
        `/api/records/${encodeURIComponent(id)}/resume`,
        noMock('重新打开'),
        { method: 'POST' },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}
