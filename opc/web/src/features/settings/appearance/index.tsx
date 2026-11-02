import { Moon, Monitor, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/theme-provider'
import { ContentSection } from '../components/content-section'

const options = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const

export function SettingsAppearance() {
  const { theme, setTheme } = useTheme()
  return (
    <ContentSection title='外观' desc='界面明暗主题。'>
      <div className='flex gap-2'>
        {options.map((o) => (
          <button
            key={o.value}
            type='button'
            onClick={() => setTheme(o.value)}
            className={cn(
              'flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground',
              theme === o.value && 'border-foreground/30 bg-accent text-foreground'
            )}
          >
            <o.icon className='size-3.5' />
            {o.label}
          </button>
        ))}
      </div>
    </ContentSection>
  )
}
