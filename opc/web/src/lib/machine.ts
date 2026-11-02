import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentExitRegion,
  Machine,
  MachineInvitation,
  MachineInviteRequest,
  MachineOrganization,
  MachineRemovalResponse,
  MachinesResponse,
} from '@shared/api'

/*
 * 正在看哪台电脑。同一个组织里的电脑彼此平等，切到哪台，整个驾驶舱的 /api 请求就转发到哪台：
 *   /api/overview  →  /api/m/<机器id>/overview
 * null 表示本机。选择存在 localStorage，重开 App 还在。
 */
const KEY = 'opc.machine'
let current: string | null =
  typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)
const listeners = new Set<() => void>()

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function setCurrent(id: string | null) {
  current = id
  if (id) {
    localStorage.setItem(KEY, id)
  } else {
    localStorage.removeItem(KEY)
  }
  listeners.forEach((fn) => fn())
}

/** 正在看的电脑 id；本机为 null */
export function useCurrentMachineId() {
  return useSyncExternalStore(subscribe, () => current)
}

/** 机器管理接口永远走本机，不转发 */
const LOCAL_ONLY = /^\/api\/machines(\/|$|\?)/

/**
 * 把本机接口路径换成某台电脑的转发路径。machine 不传 = 正在看的那台；null = 本机。
 */
export function scoped(path: string, machine: string | null = current) {
  if (!machine || !path.startsWith('/api/') || LOCAL_ONLY.test(path))
    return path
  return `/api/m/${encodeURIComponent(machine)}/${path.slice('/api/'.length)}`
}

/*
 * 多台电脑同时在场（首页把所有电脑合在一张图里）时，某一块界面属于哪台电脑：
 * 用 <MachineScope id=…> 包起来，里面的数据钩子（架构、任务、终端、浏览器……）就都去那台电脑取、往那台电脑发。
 * 没包的地方照旧跟着「正在看的那台」。id 为 null 表示本机。
 */
const Scope = createContext<{ id: string | null } | null>(null)

export function MachineScope({
  id,
  children,
}: {
  id: string | null
  children: React.ReactNode
}) {
  return createElement(Scope.Provider, { value: { id } }, children)
}

/** 这块界面该去哪台电脑：被 MachineScope 包着就是那台，否则是正在看的那台；null 为本机 */
export function useMachineId() {
  const scope = useContext(Scope)
  const viewing = useCurrentMachineId()
  return scope ? scope.id : viewing
}

async function local<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
  }
  return data as T
}

// 收到的加入邀请也靠它及时出现（全局确认弹层），所以 2 秒一轮
const machinesQuery = {
  queryKey: ['machines'],
  queryFn: () => local<MachinesResponse>('/api/machines'),
  refetchInterval: 2_000,
  // 老版本桥接服务没有这个接口：当作只有本机
  retry: false,
} as const

/** 局域网全貌：电脑、组织、邀请 */
export function useLan() {
  return useQuery(machinesQuery)
}

export function useMachines() {
  return useQuery({ ...machinesQuery, select: (r) => r.machines })
}

/** 正在看的那台；切到的电脑已不在列表里（解除配对了）时回到本机 */
export function useCurrentMachine(): Machine | undefined {
  const id = useCurrentMachineId()
  const { data } = useMachines()
  const self = data?.find((m) => m.self)
  return (id && data?.find((m) => m.id === id)) || self
}

/**
 * 正在看的电脑已经不在配对列表里（在对方那边或命令行解除了配对）：自动回到本机，
 * 不然所有请求都转发到一台不认识的电脑上。挂在顶栏里，全局只需要一处。
 */
export function useMachineGuard() {
  const id = useCurrentMachineId()
  const { data } = useMachines()
  const switchTo = useSwitchMachine()
  const gone = !!id && !!data && !data.some((m) => m.id === id && m.paired)
  useEffect(() => {
    if (gone) {
      void switchTo(null)
    }
  }, [gone, switchTo])
}

/** 切换电脑：先换转发目标，再把所有缓存的数据清掉重取，别让两台电脑的数据混在一起 */
export function useSwitchMachine() {
  const qc = useQueryClient()
  return useCallback(
    async (machine: Machine | null) => {
      const id = machine && !machine.self ? machine.id : null
      if (id === current) {
        return
      }
      const others = {
        predicate: (q: { queryKey: readonly unknown[] }) =>
          q.queryKey[0] !== 'machines',
      }
      await qc.cancelQueries(others)
      setCurrent(id)
      await qc.resetQueries(others)
    },
    [qc]
  )
}

/**
 * 首页合在一起看的电脑：没切到别的电脑时，是本机 + 配对过且在线的电脑；切到某台时只看那台。
 * id 为 null 表示本机。
 */
export function useFleet(): { id: string | null; machine?: Machine }[] {
  const viewing = useCurrentMachineId()
  const { data } = useMachines()
  if (viewing)
    return [{ id: viewing, machine: data?.find((m) => m.id === viewing) }]
  const self = data?.find((m) => m.self)
  const others = (data ?? []).filter(
    (m) => !m.self && m.paired && m.status === 'online'
  )
  return [
    { id: null, machine: self },
    ...others.map((m) => ({ id: m.id, machine: m })),
  ]
}

function useLanAction<T, V>(fn: (v: V) => Promise<T>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['machines'] }),
  })
}

/** 邀请局域网里的一台电脑加入组织（发现列表点的，或手动填地址）；对方同意后两边配对 */
export function useInviteMachine() {
  return useLanAction((req: MachineInviteRequest) =>
    local<MachineInvitation>('/api/machines/invite', req)
  )
}

/** 收到的邀请同意 / 拒绝，发出的邀请撤回 */
export function useInvitation() {
  return useLanAction(
    ({ id, action }: { id: string; action: 'accept' | 'reject' | 'cancel' }) =>
      local<MachineInvitation>(
        `/api/machines/invitations/${encodeURIComponent(id)}/${action}`,
        {}
      )
  )
}

export function useRenameOrganization() {
  return useLanAction((name: string) =>
    local<MachineOrganization>('/api/machines/organization/rename', { name })
  )
}

export function useRenameMachine() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      local<Machine>(`/api/machines/${encodeURIComponent(id)}/rename`, {
        name,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['machines'] }),
  })
}

/** 把一台电脑移出组织；id 不传 = 本机退出组织。正在看的那台被移出就回到本机 */
export function useRemoveMachine() {
  const qc = useQueryClient()
  const switchTo = useSwitchMachine()
  return useMutation({
    mutationFn: (id: string | null) =>
      local<MachineRemovalResponse>(
        id
          ? `/api/machines/${encodeURIComponent(id)}/remove`
          : '/api/machines/organization/leave',
        {}
      ),
    onSuccess: async (_, id) => {
      if (!id || id === current) {
        await switchTo(null)
      }
      qc.invalidateQueries({ queryKey: ['machines'] })
    },
  })
}

/** 某台电脑（不传 = 当前数据该去的那台）的出口地区；没检测过或对方是旧版本时为 null */
export function useExitRegion(): AgentExitRegion | null {
  const id = useMachineId()
  const { data } = useMachines()
  const m = id ? data?.find((x) => x.id === id) : data?.find((x) => x.self)
  return m?.exitRegion ?? null
}

/** 出口地区检测：强制重测本机 */
export function useRefreshExitRegion() {
  return useLanAction(() =>
    local<AgentExitRegion>('/api/exit-region/refresh', {})
  )
}
