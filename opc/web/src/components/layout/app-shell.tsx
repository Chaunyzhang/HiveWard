import { Outlet } from '@tanstack/react-router'
import { useDesktopNavigation } from '@/lib/desktop'
import { SearchProvider } from '@/context/search-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SkipToMain } from '@/components/skip-to-main'
import { DecisionsDrawer } from '@/features/decisions/decisions-drawer'
import { DecisionsDrawerProvider } from '@/features/decisions/drawer-context'
import { InvitePrompt } from '@/features/machines/invite-prompt'
import { Rail } from './rail'
import { TopBar } from './top-bar'

/** 外壳：顶栏面包屑 + 图标侧栏 + 内容区，布局同 Supabase 控制台。 */
export function AppShell() {
  useDesktopNavigation()
  return (
    <DecisionsDrawerProvider>
      <SearchProvider>
        <TooltipProvider delayDuration={200}>
          <SkipToMain />
          <div className='flex h-svh flex-col'>
            <TopBar />
            <div className='flex min-h-0 flex-1'>
              <Rail />
              <main id='content' className='min-w-0 flex-1 overflow-y-auto'>
                <Outlet />
              </main>
            </div>
          </div>
          <DecisionsDrawer />
          <InvitePrompt />
        </TooltipProvider>
      </SearchProvider>
    </DecisionsDrawerProvider>
  )
}
