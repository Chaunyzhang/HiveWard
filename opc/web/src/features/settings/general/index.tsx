import { Moon, Monitor, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/theme-provider'
import { SettingRow, SettingsTitle } from '../components/setting-row'

const options = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const

export function SettingsGeneral() {
  const { theme, setTheme } = useTheme()
  return (
    <>
      <SettingsTitle>常规</SettingsTitle>
      <SettingRow
        title='外观'
        desc='界面的明暗主题。'
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
    </>
  )
}
