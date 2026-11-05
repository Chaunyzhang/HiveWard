import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ProviderUsage,
  QuotaSettingsRequest,
  UsageResponse,
} from '@shared/api'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { timeAgo } from '@/lib/hiveward-format'
import { useQuota } from '@/lib/hiveward-live'
import { locale, tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import {
  SettingRow,
  SettingsGroup,
  SettingsTitle,
} from '../components/setting-row'

/** 本机的用量接口；不在桌面 App 里时是 404，返回 null */
async function fetchUsage(refresh: boolean): Promise<UsageResponse | null> {
  const res = await fetch(refresh ? '/api/usage/refresh' : '/api/usage', {
    method: refresh ? 'POST' : 'GET',
  })
  if (res.status === 404) {
    return null
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return res.json()
}

/** 用量：各家 Agent 的额度用了多少（5 小时、每周…），像 Claude 桌面端的「用量」 */
export function SettingsUsage() {
  const queryClient = useQueryClient()
  const { data, error, isLoading } = useQuery({
    queryKey: ['usage'],
    queryFn: () => fetchUsage(false),
    // 刚开始取的时候勤一点，取到了就一分钟看一次
    refetchInterval: (q) => (q.state.data?.providers.length ? 60_000 : 3_000),
    retry: false,
  })
  const refresh = useMutation({
    mutationFn: () => fetchUsage(true),
    onSuccess: (next) => queryClient.setQueryData(['usage'], next),
    onError: (e) => toast.error(tr('没刷新成：{0}', [e.message])),
  })
  return (
    <>
      <div className='flex items-center gap-3'>
        <SettingsTitle>{tr('用量')}</SettingsTitle>
        {data && (
          <button
            type='button'
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
            className='ms-auto mb-4 flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50'
          >
            <RefreshCw
              className={cn('size-3.5', refresh.isPending && 'animate-spin')}
            />
            {tr('刷新')}
          </button>
        )}
      </div>
      <p className='-mt-2 mb-8 text-[13px] leading-5 text-muted-foreground'>
        {tr('各家 Agent 的额度用了多少。数据来自这台电脑上登录的账号。')}
      </p>
      <AutoResume />
      {isLoading ? (
        <p className='text-[13px] text-muted-foreground'>{tr('读取中…')}</p>
      ) : error ? (
        <p className='text-[13px] text-danger'>
          {tr('读不到：{0}', [error.message])}
        </p>
      ) : data === null ? (
        <p className='text-[13px] text-muted-foreground'>
          {tr('用量只在 HiveWard 桌面 App 里能看。')}
        </p>
      ) : !data?.providers.length ? (
        <p className='text-[13px] text-muted-foreground'>
          {data?.available
            ? tr(
                '正在读各家的用量…读不到的话，登录过 Claude Code、Codex 等之后再刷新看看。'
              )
            : tr('还在读，过一会儿再看。')}
        </p>
      ) : (
        data.providers.map((p) => <Provider key={p.id} p={p} />)
      )}
    </>
  )
}

/** 「额度恢复后自动继续」：存在本机后台，恢复后它替你给停下的下属发「接着做」 */
function AutoResume() {
  const queryClient = useQueryClient()
  const { data } = useQuota()
  const save = useMutation({
    mutationFn: async (autoResume: boolean) => {
      const res = await fetch('/api/quota/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoResume } satisfies QuotaSettingsRequest),
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['quota'] }),
    onError: (e) => toast.error(tr('没存上：{0}', [e.message])),
  })
  if (!data) {
    return null
  }
  return (
    <div className='-mt-4 mb-6'>
      <SettingRow
        title={tr('额度恢复后自动继续')}
        desc={tr(
          '下属因为额度用完停下后，到了恢复时间自动叫它接着做；出错时丢掉的消息一并重发。'
        )}
        control={
          <Switch
            checked={data.autoResume}
            disabled={save.isPending}
            onCheckedChange={(v) => save.mutate(v)}
          />
        }
      />
    </div>
  )
}

function Provider({ p }: { p: ProviderUsage }) {
  return (
    <SettingsGroup title={p.plan ? `${p.name} · ${p.plan}` : p.name}>
      {p.error ? (
        <p className='py-2 text-[13px] text-danger'>{p.error}</p>
      ) : (
        <div className='divide-y'>
          {p.windows.map((w) => (
            <div key={w.label} className='flex items-center gap-6 py-4'>
              <div className='w-40 shrink-0'>
                <p className='text-[14px]'>{w.label}</p>
                {w.resetsAt && (
                  <p className='mt-0.5 text-xs text-muted-foreground'>
                    {resetIn(w.resetsAt)}
                  </p>
                )}
              </div>
              <div className='h-2 flex-1 overflow-hidden rounded-full bg-muted'>
                <div
                  className={cn(
                    'h-full rounded-full',
                    w.usedPercent >= 90
                      ? 'bg-danger'
                      : w.usedPercent >= 70
                        ? 'bg-attention'
                        : 'bg-brand'
                  )}
                  style={{ width: `${w.usedPercent}%` }}
                />
              </div>
              <span className='w-20 shrink-0 text-end text-[13px] text-muted-foreground tabular-nums'>
                {tr('已用 {0}%', [Math.round(w.usedPercent)])}
              </span>
            </div>
          ))}
        </div>
      )}
      {p.updatedAt && (
        <p className='pt-1 text-xs text-muted-foreground'>
          {tr('{0}更新', [timeAgo(p.updatedAt)])}
        </p>
      )}
    </SettingsGroup>
  )
}

/** 「3 小时 20 分钟后重置」；跨天写日期 */
function resetIn(iso: string) {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) {
    return tr('已经重置')
  }
  const min = Math.round(ms / 60_000)
  if (min < 60) {
    return tr('{0} 分钟后重置', [min])
  }
  const h = Math.floor(min / 60)
  if (h < 24) {
    return tr('{0} 小时 {1} 分钟后重置', [h, min % 60])
  }
  return tr('{0}重置', [
    new Date(iso).toLocaleString(locale, {
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }),
  ])
}
