import type { Harness } from '@shared/api'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useHarnesses, useRefreshHarnesses } from '@/lib/hiveward-api'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { AgentLogo } from '@/components/hiveward/agent-logo'
import { HarnessMeta } from '@/features/workbench/personal-agent'
import { SettingsGroup, SettingsTitle } from '../components/setting-row'

/**
 * 本机 Agent（Harness）：这台电脑上认出来的 Agent，分 Personal Agent 和 Coding Agent 两类。
 * 命令行由引擎检测（和 HiveWard 设置页「已安装」同一份），桌面 App 看应用程序文件夹。只读。
 */
export function SettingsAgents() {
  const { data, error, isLoading } = useHarnesses(null)
  const refresh = useRefreshHarnesses(null)
  const personal = data?.personal ?? []
  const installed = personal.filter((h) => h.installed).length
  return (
    <>
      <div className='flex items-center gap-3'>
        <SettingsTitle>{tr('本机 Agent')}</SettingsTitle>
        <button
          type='button'
          disabled={refresh.isPending}
          onClick={() =>
            refresh.mutate(undefined, {
              onError: (e) => toast.error(tr('没认成：{0}', [e.message])),
            })
          }
          className='ms-auto mb-4 flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50'
        >
          <RefreshCw
            className={cn('size-3.5', refresh.isPending && 'animate-spin')}
          />
          {tr('重新认一遍')}
        </button>
      </div>
      <p className='-mt-2 mb-8 text-[13px] leading-5 text-muted-foreground'>
        {tr(
          'HiveWard 认出这台电脑上装了哪些 Agent。Personal Agent 坐业务的 Personal Agent 位；Coding Agent 坐 CEO、Leader 和下属位。'
        )}
      </p>
      {isLoading ? (
        <p className='text-[13px] text-muted-foreground'>{tr('正在认…')}</p>
      ) : error ? (
        <p className='text-[13px] text-danger'>
          {tr('没认出来：{0}', [error.message])}
        </p>
      ) : (
        <>
          <SettingsGroup title='Personal Agent'>
            <p className='mb-2 text-[13px] text-muted-foreground'>
              {tr('常驻的 AI 同事，帮你盯业务、给 Agent 派活 · 装了 {0}/{1}', [
                installed,
                personal.length,
              ])}
            </p>
            <List items={personal} />
          </SettingsGroup>
          <SettingsGroup title='Coding Agent'>
            <p className='mb-2 text-[13px] text-muted-foreground'>
              {tr('写代码的命令行 · 认出 {0} 个', [data?.coding.length ?? 0])}
            </p>
            {data?.error ? (
              <p className='py-3 text-[13px] text-danger'>{data.error}</p>
            ) : data?.coding.length ? (
              <List items={data.coding} />
            ) : (
              <p className='py-3 text-[13px] text-muted-foreground'>
                {tr('没认出 Coding Agent。')}
              </p>
            )}
          </SettingsGroup>
        </>
      )}
    </>
  )
}

function List({ items }: { items: Harness[] }) {
  return (
    <ul>
      {items.map((h) => (
        <li
          key={h.id}
          className={cn(
            'flex items-center gap-3 border-b py-3 last:border-b-0',
            !h.installed && 'opacity-55'
          )}
        >
          <span className='grid size-9 shrink-0 place-items-center rounded-lg border bg-panel'>
            <AgentLogo agent={h.id} className='size-5' />
          </span>
          <span className='min-w-0 flex-1'>
            <span className='block text-[14px]'>{h.name}</span>
            {h.kind === 'coding' ? (
              <code className='font-mono text-xs text-muted-foreground'>
                {h.command}
              </code>
            ) : (
              <HarnessMeta h={h} />
            )}
          </span>
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-xs',
              h.installed
                ? 'bg-live/10 text-live'
                : 'bg-muted text-muted-foreground'
            )}
          >
            {h.installed ? tr('已安装') : tr('没装')}
          </span>
        </li>
      ))}
    </ul>
  )
}
