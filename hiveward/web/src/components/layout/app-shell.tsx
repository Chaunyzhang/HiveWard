import { Outlet } from '@tanstack/react-router'
import { useDesktopFileOpen, useDesktopNavigation } from '@/lib/desktop'
import { SearchProvider } from '@/context/search-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SkipToMain } from '@/components/skip-to-main'
import { InvitePrompt } from '@/features/machines/invite-prompt'
import { SettingsDialog } from '@/features/settings'
import { Rail } from './rail'
import { SidePanel } from './side-panel'
import { TopBar } from './top-bar'

/**
 * 外壳：三栏都从窗口顶上开始，各自的顶行同高连成一排（像 Claude 桌面端）——
 * 左栏（左上角是会话栏开关、前进后退）、中间栏（顶栏 + 主页 / 会话）、右栏（更改 / 浏览器 / 文件…）。
 */
export function AppShell() {
  useDesktopNavigation()
  useDesktopFileOpen()
  return (
    <SearchProvider>
      <TooltipProvider delayDuration={200}>
        <SkipToMain />
        <div className='flex h-svh'>
          <Rail />
          <div className='flex min-w-0 flex-1 flex-col'>
            <TopBar />
            <main
              id='content'
              className='@container min-h-0 min-w-0 flex-1 overflow-y-auto'
            >
              <Outlet />
            </main>
          </div>
          <SidePanel />
        </div>
        <InvitePrompt />
        <SettingsDialog />
      </TooltipProvider>
    </SearchProvider>
  )
}
