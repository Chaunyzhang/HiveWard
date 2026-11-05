import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { tr } from '@/lib/i18n'
import { scoped, useMachineId } from './machine'

/*
 * 会话工具栏右侧面板用的接口：更改（git status / diff）、计划（Agent 自己列的待办）、保持唤醒。
 * 后台版本旧、还没有这些接口时返回 404：面板说明一句，按钮不出现，不当成出错。
 */

export class MissingEndpoint extends Error {}

async function getJson<T>(
  path: string,
  machine: string | null,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(scoped(path, machine), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const body = await res.json().catch(() => null)
  if (
    res.status === 404 &&
    body?.error?.code === 'not_found' &&
    body?.error?.message?.startsWith('/api/')
  ) {
    throw new MissingEndpoint(tr('后台版本还没有这个接口'))
  }
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 接口返回的 JSON 由调用方按 shared/api 的类型声明
  return body as T
}

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString()

export type ChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflict'

export type WorkspaceChange = {
  /** 相对仓库根 */
  path: string
  oldPath?: string
  status: ChangeStatus
  staged: boolean
  unstaged: boolean
}

export type WorkspaceChanges = {
  dir: string
  git: boolean
  root?: string
  branch?: string | null
  files: WorkspaceChange[]
  truncated?: boolean
}

export type FileDiff = {
  path: string
  status: ChangeStatus
  diff: string
  truncated: boolean
}

const noRetryMissing = (n: number, e: Error) =>
  !(e instanceof MissingEndpoint) && n < 1

export function useWorkspaceChanges(dir: string | null) {
  const m = useMachineId()
  return useQuery({
    queryKey: ['workspace-changes', dir, m],
    enabled: !!dir,
    queryFn: () =>
      getJson<WorkspaceChanges>(
        `/api/workspace/changes?${qs({ path: dir! })}`,
        m
      ),
    refetchInterval: (q) =>
      q.state.error instanceof MissingEndpoint ? false : 5_000,
    retry: noRetryMissing,
  })
}

export function useFileDiff(dir: string | null, file: string | null) {
  const m = useMachineId()
  return useQuery({
    queryKey: ['workspace-diff', dir, file, m],
    enabled: !!dir && !!file,
    queryFn: () =>
      getJson<FileDiff>(
        `/api/workspace/changes/diff?${qs({ path: dir!, file: file! })}`,
        m
      ),
    refetchInterval: 5_000,
    retry: noRetryMissing,
  })
}

export type PlanItem = {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type SessionPlan = {
  agent: string | null
  source: string | null
  items: PlanItem[]
  updatedAt: string | null
}

export function useSessionPlan(handle: string | null) {
  const m = useMachineId()
  return useQuery({
    queryKey: ['session-plan', handle, m],
    enabled: !!handle,
    queryFn: () =>
      getJson<SessionPlan>(
        `/api/hiveward/terminals/${encodeURIComponent(handle!)}/plan`,
        m
      ),
    refetchInterval: (q) =>
      q.state.error instanceof MissingEndpoint ? false : 3_000,
    retry: noRetryMissing,
  })
}

export type SessionAwake = {
  handle: string
  /** 这个会话按着「保持唤醒」 */
  on: boolean
  /** 电脑现在确实不会睡 */
  active: boolean
  mode: 'on' | 'off' | 'auto'
}

/** 只在本机：保持唤醒改的是这台电脑的电源设置，局域网另一头不能替你开 */
export function useSessionAwake(handle: string | null) {
  return useQuery({
    queryKey: ['session-awake', handle],
    enabled: !!handle,
    queryFn: () =>
      getJson<SessionAwake>(
        `/api/session-awake?${qs({ handle: handle! })}`,
        null
      ),
    refetchInterval: (q) =>
      q.state.error instanceof MissingEndpoint ? false : 10_000,
    retry: false,
  })
}

export function useToggleSessionAwake(handle: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (on: boolean) =>
      getJson<SessionAwake>('/api/session-awake', null, {
        method: 'POST',
        body: JSON.stringify({ handle, on }),
      }),
    onSuccess: (data) => qc.setQueryData(['session-awake', handle], data),
  })
}
