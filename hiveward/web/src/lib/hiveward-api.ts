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
  HarnessesResponse,
  LaunchCeoRequest,
  LaunchProjectLeaderRequest,
  LaunchWorkerRequest,
  LaunchWorkerResponse,
  LeaderScreenResponse,
  OverviewResponse,
  PatrolSettings,
  ResolveDecisionRequest,
  ResumeRecordResponse,
  ReviewTaskRequest,
  ReviewTaskResponse,
  Task,
  TopologyResponse,
  Project,
  RegisterBusinessRequest,
  SetProjectScheduleRequest,
  UpdateBusinessProjectRequest,
  UpdateBusinessRequest,
} from '@shared/api'
import { lang, tr, trData } from '@/lib/i18n'
import { scoped, useMachineId } from './machine'

// 默认走真实 /api（vite 代理到本机 server/hiveward-bridge.mjs）；设置 VITE_API_MOCK=true 改看模拟数据。
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

/** 界面是英文时，把后台送来的固定说法换成英文（名字不动；「未归项目」这一行例外，它是后台起的名） */
function localizeTopology(t: TopologyResponse): TopologyResponse {
  if (lang !== 'en') {
    return t
  }
  return {
    ...t,
    nodes: t.nodes.map((n) => ({
      ...n,
      label: n.label === '未归项目' ? trData(n.label) : n.label,
      sublabel: n.sublabel && trData(n.sublabel),
      activity: n.activity && trData(n.activity),
      stats: n.stats?.map(trData),
    })),
  }
}

export const topologyQuery = (m: string | null, businessId?: string) => ({
  queryKey: ['topology', businessId ?? 'company', m],
  queryFn: () =>
    request<TopologyResponse>(
      `/api/topology${qs({ businessId })}`,
      () => mockTopology(businessId),
      undefined,
      m
    ).then(localizeTopology),
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
  throw new Error(tr('模拟数据下不能{0}', [what]))
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
        noMock(tr('加业务')),
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
        noMock(tr('改业务')),
        { method: 'PATCH', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/**
 * 那台电脑上装了哪些 Agent：Personal Agent / Coding Agent 分开（GET /api/harnesses）。
 * machine 传 null 看本机；不传跟着当前看的电脑。
 */
export function useHarnesses(machine?: string | null) {
  const viewing = useMachineId()
  const m = machine === undefined ? viewing : machine
  return useQuery({
    queryKey: ['harnesses', m],
    queryFn: () =>
      request<HarnessesResponse>(
        '/api/harnesses',
        noMock(tr('看本机 Agent')),
        undefined,
        m
      ),
    staleTime: 30_000,
    retry: false,
  })
}

/** 重新认一遍（引擎重新补 PATH、重新找命令行） */
export function useRefreshHarnesses(machine: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      request<HarnessesResponse>(
        '/api/harnesses?refresh=1',
        noMock(tr('看本机 Agent')),
        undefined,
        machine
      ),
    onSuccess: (data) => queryClient.setQueryData(['harnesses', machine], data),
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
        noMock(tr('移除业务')),
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
        noMock(tr('建项目')),
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 老板在架构图上直接派一个下属（带 projectId 进项目，不带挂在 CEO 后面） */
export function useLaunchWorker(businessId: string) {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: (body: LaunchWorkerRequest) =>
      request<LaunchWorkerResponse>(
        `${businessPath(businessId)}/workers`,
        noMock(tr('派下属')),
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
        noMock(tr('改项目')),
        { method: 'PATCH', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 项目的定时巡检：开关、间隔、Agent、巡检的话、上一轮没做完就跳过、预设 */
export function useSetProjectSchedule() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: ({
      project: p,
      ...body
    }: SetProjectScheduleRequest & { project: Project }) =>
      request<{ project: Project }>(
        `${businessPath(p.businessId)}/projects/${encodeURIComponent(p.id)}/schedule`,
        noMock(tr('改巡检设置')),
        { method: 'PUT', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 设置 → 常规：定时巡检（只在本机） */
export function usePatrolSettings() {
  return useQuery({
    queryKey: ['patrol-settings'],
    queryFn: () =>
      request<PatrolSettings>(
        '/api/settings/patrol',
        () => ({ idleCloseMinutes: 60 }),
        undefined,
        null
      ),
  })
}

export function useSetPatrolSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: PatrolSettings) =>
      request<PatrolSettings>(
        '/api/settings/patrol',
        noMock(tr('改巡检设置')),
        { method: 'PUT', body: JSON.stringify(body) },
        null
      ),
    onSuccess: (data) => queryClient.setQueryData(['patrol-settings'], data),
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
        noMock(tr('开 Leader Agent')),
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
        noMock(tr('复核')),
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
        noMock(tr('重新打开')),
        { method: 'POST' },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

/** 开终端坐这块业务的 CEO 位（已有人坐着时不带 replace 就只把 prompt 发给它） */
export function useLaunchCeo() {
  const queryClient = useQueryClient()
  const m = useMachineId()
  return useMutation({
    mutationFn: ({
      businessId,
      ...body
    }: LaunchCeoRequest & { businessId: string }) =>
      request<{ business: BusinessSummary; terminal: string }>(
        `${businessPath(businessId)}/ceo`,
        noMock(tr('开 CEO Agent')),
        { method: 'POST', body: JSON.stringify(body) },
        m
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}
