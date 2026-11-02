import { useEffect } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from '@/context/theme-provider'
import { IconButton } from '@/components/layout/icon-button'

export function ThemeSwitch() {
  const { resolvedTheme, setTheme } = useTheme()

  useEffect(() => {
    const meta = document.querySelector("meta[name='theme-color']")
    meta?.setAttribute('content', resolvedTheme === 'dark' ? '#2e2e2e' : '#fcfcfc')
  }, [resolvedTheme])

  const dark = resolvedTheme === 'dark'
  return (
    <IconButton
      label={dark ? '切换到浅色' : '切换到深色'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <Sun /> : <Moon />}
    </IconButton>
  )
}
