import { useState } from 'react'
import { toast } from 'sonner'
import { tr, trData } from '@/lib/i18n'
import { useLan, useRefreshExitRegion, useRenameMachine } from '@/lib/machine'
import { Input } from '@/components/ui/input'
import { ExitRegionLine } from '@/components/hiveward/exit-region'
import { SettingRow, SettingsTitle } from '../components/setting-row'

/** 这台电脑：名字、出口地区（Claude Code / ChatGPT 能不能在这台开） */
export function SettingsMachine() {
  const lan = useLan()
  const self = lan.data?.machines.find((m) => m.self)
  const rename = useRenameMachine()
  const refresh = useRefreshExitRegion()
  const [name, setName] = useState<string | null>(null)

  return (
    <>
      <SettingsTitle>{tr('这台电脑')}</SettingsTitle>
      <SettingRow
        title={tr('电脑名')}
        desc={tr('组织里的其他电脑看到的名字。')}
        control={
          name === null ? (
            <button
              type='button'
              disabled={!self}
              onClick={() => setName(self?.name ?? '')}
              className='flex h-8 items-center gap-2 rounded-md border px-3 text-[13px] hover:bg-accent disabled:opacity-50'
            >
              {self?.name ?? tr('读取中…')}
            </button>
          ) : (
            <form
              className='flex gap-2'
              onSubmit={(e) => {
                e.preventDefault()
                const next = name.trim()
                if (self && next && next !== self.name) {
                  rename.mutate(
                    { id: self.id, name: next },
                    {
                      onError: (err) =>
                        toast.error(tr('没改成：{0}', [err.message])),
                    }
                  )
                }
                setName(null)
              }}
            >
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setName(null)}
                className='h-8 w-48 text-[13px]'
              />
            </form>
          )
        }
      />
      <SettingRow
        title={tr('出口地区')}
        desc={
          <>
            {tr(
              '安全底线：Claude Code、ChatGPT 只在美国出口的电脑上开，出口测不出也不开。{0}',
              [
                self?.exitRegion?.limitation &&
                  trData(self.exitRegion.limitation),
              ]
            )}
            <ExitRegionLine
              region={self?.exitRegion ?? null}
              className='mt-2'
            />
            {self?.exitRegion?.warnings?.map((w) => (
              <p key={w.id} className='mt-1 text-[12px] text-danger'>
                {w.message}
              </p>
            ))}
          </>
        }
        control={
          <button
            type='button'
            disabled={refresh.isPending}
            onClick={() =>
              refresh.mutate(undefined, {
                onError: (e) => toast.error(tr('没测成：{0}', [e.message])),
              })
            }
            className='h-8 rounded-md border px-3 text-[13px] hover:bg-accent disabled:opacity-50'
          >
            {refresh.isPending ? tr('检测中…') : tr('重新检测')}
          </button>
        }
      />
    </>
  )
}
