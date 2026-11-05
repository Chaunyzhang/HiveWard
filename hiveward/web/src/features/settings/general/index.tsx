import { useState } from 'react'
import { Moon, Monitor, Search, Sun } from 'lucide-react'
import { toast } from 'sonner'
import { usePatrolSettings, useSetPatrolSettings } from '@/lib/hiveward-api'
import { lang, setLang, tr, type Lang } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useSearch } from '@/context/search-provider'
import { useTheme } from '@/context/theme-provider'
import { useHiveWardStatus } from '@/hooks/use-hiveward-status'
import { useSettings } from '..'
import { SettingRow, SettingsTitle } from '../components/setting-row'
import { MigrationRow } from './migration-row'

const options = [
  { value: 'light', label: tr('浅色'), icon: Sun },
  { value: 'dark', label: tr('深色'), icon: Moon },
  { value: 'system', label: tr('跟随系统'), icon: Monitor },
] as const

// 语言名各用自己的写法，切到哪种都认得出
const languages: { value: Lang; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

export function SettingsGeneral() {
  const { theme, setTheme } = useTheme()
  return (
    <>
      <SettingsTitle>{tr('常规')}</SettingsTitle>
      <SettingRow
        title={tr('外观')}
        desc={tr('界面的明暗主题。')}
        control={
          <div className='flex gap-1 rounded-lg bg-muted p-0.5'>
            {options.map((o) => (
              <button
                key={o.value}
                type='button'
                onClick={() => setTheme(o.value)}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
                  theme === o.value && 'bg-background text-foreground shadow-sm'
                )}
              >
                <o.icon className='size-3.5' />
                {o.label}
              </button>
            ))}
          </div>
        }
      />
      <SettingRow
        title={tr('语言')}
        desc={tr('界面显示的语言。换了会重新加载一下。')}
        control={
          <div className='flex gap-1 rounded-lg bg-muted p-0.5'>
            {languages.map((o) => (
              <button
                key={o.value}
                type='button'
                onClick={() => setLang(o.value)}
                className={cn(
                  'flex h-7 items-center rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
                  lang === o.value && 'bg-background text-foreground shadow-sm'
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        }
      />
      <SearchRow />
      <PatrolIdleRow />
      <EngineRow />
      <MigrationRow />
    </>
  )
}

const engineDot = {
  ok: 'bg-live',
  warn: 'bg-danger',
  error: 'bg-danger',
  idle: 'bg-muted-foreground/50',
}

/** 全局搜索：快捷键随处可用，这里给个入口 */
function SearchRow() {
  const { setOpen } = useSearch()
  const close = useSettings((s) => s.close)
  const key = navigator.userAgent.includes('Mac') ? '⌘K' : 'Ctrl K'
  return (
    <SettingRow
      title={tr('搜索')}
      desc={tr('在任何页面按 {0}，跳转到业务、页面或执行命令。', [key])}
      control={
        <button
          type='button'
          onClick={() => {
            close()
            setOpen(true)
          }}
          className='flex h-8 items-center gap-2 rounded-md border px-3 text-[13px] hover:bg-accent'
        >
          <Search className='size-3.5 text-muted-foreground' />
          {tr('打开搜索')}
          <kbd className='font-mono text-xs text-muted-foreground'>{key}</kbd>
        </button>
      }
    />
  )
}

/** 定时巡检每轮新开一个 Agent；这一轮结束后空闲满这么久，终端自动关掉 */
function PatrolIdleRow() {
  const { data } = usePatrolSettings()
  const save = useSetPatrolSettings()
  const [draft, setDraft] = useState<string | null>(null)
  const saved = data?.idleCloseMinutes
  const commit = () => {
    if (draft === null) {
      return
    }
    const minutes = Number(draft)
    setDraft(null)
    if (minutes === saved) {
      return
    }
    if (!Number.isInteger(minutes) || minutes < 10 || minutes > 1440) {
      toast.error(tr('填 10 到 1440 之间的整数分钟'))
      return
    }
    save.mutate(
      { idleCloseMinutes: minutes },
      {
        onSuccess: () =>
          toast.success(tr('已改成空闲 {0} 分钟自动关', [String(minutes)])),
        onError: (e) => toast.error(tr('没改成：{0}', [e.message])),
      }
    )
  }
  return (
    <SettingRow
      title={tr('巡检终端空闲自动关')}
      desc={tr(
        '定时巡检每轮新开一个 Agent。这一轮做完后空闲满这么久，就关掉它的终端，报告留在运行记录里；中途你跟它说话、它又干活了，就从下次做完重新算。'
      )}
      control={
        <label className='flex h-8 items-center gap-2 text-[13px] text-muted-foreground'>
          <input
            type='number'
            min={10}
            max={1440}
            step={10}
            aria-label={tr('空闲多少分钟后关')}
            disabled={saved === undefined}
            value={draft ?? saved ?? ''}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            className='h-8 w-20 rounded-md border bg-transparent px-2 text-end font-mono text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring'
          />
          {tr('分钟')}
        </label>
      }
    />
  )
}

/** 执行引擎是否正常；异常时顶栏也会有个红色提示点进这里 */
function EngineRow() {
  const { tone, label, hint, health } = useHiveWardStatus()
  return (
    <SettingRow
      title={tr('引擎')}
      desc={
        <>
          {hint}
          {health?.appVersion && (
            <span className='ms-1 font-mono text-xs'>
              {tr('版本 {0}', [health.appVersion])}
            </span>
          )}
        </>
      }
      control={
        <span
          className={cn(
            'flex h-8 items-center gap-2 text-[13px]',
            tone === 'error' || tone === 'warn'
              ? 'text-danger'
              : 'text-muted-foreground'
          )}
        >
          <span className={cn('size-2 rounded-full', engineDot[tone])} />
          {label}
        </span>
      }
    />
  )
}
