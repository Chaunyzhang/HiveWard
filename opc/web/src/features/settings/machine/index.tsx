import { useState } from 'react'
import { toast } from 'sonner'
import { useLan, useRefreshExitRegion, useRenameMachine } from '@/lib/machine'
import { Input } from '@/components/ui/input'
import { ExitRegionLine } from '@/components/opc/exit-region'
import { SettingRow, SettingsTitle } from '../components/setting-row'

/** 这台电脑：名字、出口地区（Claude Code / Codex 能不能在这台开） */
export function SettingsMachine() {
  const lan = useLan()
  const self = lan.data?.machines.find((m) => m.self)
  const rename = useRenameMachine()
  const refresh = useRefreshExitRegion()
  const [name, setName] = useState<string | null>(null)

  return (
    <>
      <SettingsTitle>这台电脑</SettingsTitle>
      <SettingRow
        title='电脑名'
        desc='组织里的其他电脑看到的名字。'
        control={
          name === null ? (
            <button
              type='button'
              disabled={!self}
              onClick={() => setName(self?.name ?? '')}
              className='flex h-8 items-center gap-2 rounded-md border px-3 text-[13px] hover:bg-accent disabled:opacity-50'
            >
              {self?.name ?? '读取中…'}
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
                    { onError: (err) => toast.error(`没改成：${err.message}`) }
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
        title='出口地区'
        desc={
          <>
            安全底线：Claude Code、Codex
            只在美国出口的电脑上开，出口测不出也不开。
            {self?.exitRegion?.limitation}
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
                onError: (e) => toast.error(`没测成：${e.message}`),
              })
            }
            className='h-8 rounded-md border px-3 text-[13px] hover:bg-accent disabled:opacity-50'
          >
            {refresh.isPending ? '检测中…' : '重新检测'}
          </button>
        }
      />
    </>
  )
}
