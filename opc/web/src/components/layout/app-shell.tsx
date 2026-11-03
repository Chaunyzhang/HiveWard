import { Outlet } from '@tanstack/react-router'
import { useDesktopNavigation } from '@/lib/desktop'
import { SearchProvider } from '@/context/search-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SkipToMain } from '@/components/skip-to-main'
import { InvitePrompt } from '@/features/machines/invite-prompt'
import { Rail } from './rail'
import { SidePanel } from './side-panel'
import { TopBar } from './top-bar'

/** 外壳：顶栏 + 三栏——左栏导航（集团 / 业务）、中间栏主页、右栏文件 / 浏览器。 */
export function AppShell() {
  useDesktopNavigation()
  return (
    <SearchProvider>
      <TooltipProvider delayDuration={200}>
        <SkipToMain />
        <div className='flex h-svh flex-col'>
          <TopBar />
          <div className='flex min-h-0 flex-1'>
            <Rail />
            <main
              id='content'
              className='@container min-w-0 flex-1 overflow-y-auto'
            >
              <Outlet />
            </main>
            <SidePanel />
          </div>
        </div>
        <InvitePrompt />
      </TooltipProvider>
    </SearchProvider>
  )
}
