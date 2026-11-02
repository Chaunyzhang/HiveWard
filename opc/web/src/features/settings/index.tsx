import { Outlet } from '@tanstack/react-router'
import { Palette } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { Page } from '@/components/layout/page'
import { SidebarNav } from './components/sidebar-nav'

const sidebarNavItems = [
  {
    title: '外观',
    href: '/settings/appearance',
    icon: <Palette size={18} />,
  },
]

export function Settings() {
  return (
    <>
      {/* ===== Top Heading ===== */}
      <Page>
        <div className='space-y-0.5'>
          <h1 className='text-xl font-medium'>设置</h1>
          <p className='text-muted-foreground'>界面外观。</p>
        </div>
        <Separator className='my-4 lg:my-6' />
        <div className='flex flex-1 flex-col space-y-2 overflow-hidden md:space-y-2 lg:flex-row lg:space-y-0 lg:space-x-12'>
          <aside className='top-0 lg:sticky lg:w-1/5'>
            <SidebarNav items={sidebarNavItems} />
          </aside>
          <div className='flex w-full overflow-y-hidden p-1'>
            <Outlet />
          </div>
        </div>
      </Page>
    </>
  )
}
