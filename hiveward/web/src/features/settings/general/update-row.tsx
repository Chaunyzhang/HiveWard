import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { tr } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import type { HiveWardUpdateSnapshot } from '../../../../../shared/api'
import { SettingRow } from '../components/setting-row'

function updateError(message: string): string {
  if (message.startsWith('更新准备失败：')) {
    return tr('更新准备失败，请重试。')
  }
  if (message.startsWith('更新服务器返回 ')) {
    return tr('更新服务器返回错误，请稍后重试。')
  }
  return tr(message)
}

async function updateRequest(
  path = '',
  body?: object
): Promise<HiveWardUpdateSnapshot> {
  const response = await fetch(
    `/api/updates${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined
  )
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(
      updateError(data?.error?.message ?? '更新服务暂不可用，请重试。')
    )
  }
  return response.json()
}
export function UpdateRow() {
  const [confirming, setConfirming] = useState(false)
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['updates'],
    queryFn: () => updateRequest(),
    refetchInterval: 2000,
  })
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) =>
      updateRequest(path, body ?? {}),
    onSuccess: (data) => client.setQueryData(['updates'], data),
  })
  const data = query.data
  const status = data?.status
  const busy =
    action.isPending ||
    status?.state === 'checking' ||
    status?.state === 'downloading'
  return (
    <>
      <SettingRow
        title={data ? tr('版本 {0}', [data.appVersion]) : tr('版本')}
        desc={tr(
          '从 GitHub 上 HiveWard 的正式发布版本检查更新，下载后核对过再装。'
        )}
        control={
          <Button
            variant='outline'
            size='sm'
            disabled={!data || busy}
            onClick={() => action.mutate({ path: '/check' })}
          >
            {status?.state === 'checking' ? tr('正在检查…') : tr('检查更新')}
          </Button>
        }
      />
      <SettingRow
        title={tr('自动检查更新')}
        desc={tr('启动后检查一次，此后每 6 小时检查。')}
        control={
          <Switch
            checked={data?.automatic ?? true}
            disabled={!data || action.isPending}
            onCheckedChange={(enabled) =>
              action.mutate({ path: '/automatic', body: { enabled } })
            }
          />
        }
      />
      {query.isPending && (
        <p className='text-sm text-muted-foreground'>
          {tr('正在读取版本信息…')}
        </p>
      )}
      {(query.error || action.error || status?.state === 'error') && (
        <p role='alert' className='text-sm text-destructive'>
          {updateError(
            status?.message ??
              action.error?.message ??
              query.error?.message ??
              '更新失败，请重试。'
          )}
          <Button
            variant='ghost'
            size='sm'
            onClick={() => {
              action.reset()
              void query.refetch()
            }}
          >
            {tr('重试')}
          </Button>
        </p>
      )}
      {status?.state === 'not-available' && (
        <p role='status' className='text-sm text-muted-foreground'>
          {tr('已是最新版本')}
        </p>
      )}
      {status?.version && (
        <div className='space-y-2 text-sm'>
          <p role='status'>{tr('有新版本 {0}', [status.version])}</p>
          {data?.notes && (
            <p className='break-words whitespace-pre-wrap text-muted-foreground'>
              {data.notes}
            </p>
          )}
          {status.state === 'downloading' ? (
            <p role='status'>
              {tr('正在下载 {0}%', [Math.round(status.percent ?? 0)])}
            </p>
          ) : (
            (status.state === 'available' || status.state === 'downloaded') && (
              <Button
                size='sm'
                disabled={busy}
                onClick={() => {
                  if (status.state === 'downloaded') {
                    setConfirming(true)
                  } else {
                    action.mutate({ path: '/download' })
                  }
                }}
              >
                {status.state === 'downloaded' ? tr('重启并更新') : tr('更新')}
              </Button>
            )
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={tr('更新 HiveWard')}
        desc={
          (data?.workingAgents ?? 0) > 0
            ? tr('{0} 个 Agent 正在干活，更新会重启 HiveWard 打断它们', [
                data?.workingAgents ?? 0,
              ])
            : tr('更新会重启 HiveWard')
        }
        confirmText={tr('现在更新')}
        cancelBtnText={tr('稍后')}
        isLoading={action.isPending}
        handleConfirm={() => {
          action.mutate({
            path: '/install',
            body: {
              version: status?.version,
              workingAgents: data?.workingAgents ?? 0,
            },
          })
          setConfirming(false)
        }}
      />
    </>
  )
}
