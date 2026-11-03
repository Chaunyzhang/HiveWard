import { Link, Outlet } from '@tanstack/react-router'
import { Laptop, Settings2, Share2, type LucideIcon } from 'lucide-react'

const groups: {
  label: string
  items: { title: string; href: string; icon: LucideIcon }[]
}[] = [
  {
    label: '偏好',
    items: [{ title: '常规', href: '/settings/general', icon: Settings2 }],
  },
  {
    label: '此电脑',
    items: [
      { title: '这台电脑', href: '/settings/machine', icon: Laptop },
      { title: '共享', href: '/settings/sharing', icon: Share2 },
    ],
  },
]

/** 设置：左边分组导航，右边一页一页的设置（样式照 Claude 桌面端的设置） */
export function Settings() {
  return (
    <div className='flex min-h-full'>
      <aside className='sticky top-0 h-svh w-56 shrink-0 space-y-6 overflow-y-auto border-e px-3 py-8'>
        {groups.map((g) => (
          <div key={g.label}>
            <p className='px-3 pb-1.5 text-xs text-muted-foreground'>
              {g.label}
            </p>
            <nav className='space-y-0.5'>
              {g.items.map((item) => (
                <Link
                  key={item.href}
                  to={item.href}
                  className='flex h-9 items-center gap-3 rounded-lg px-3 text-[13px] text-foreground/80 hover:bg-accent hover:text-foreground'
                  activeProps={{
                    className: 'bg-accent font-medium text-foreground',
                  }}
                >
                  <item.icon className='size-4 shrink-0' />
                  {item.title}
                </Link>
              ))}
            </nav>
          </div>
        ))}
      </aside>
      <div className='min-w-0 flex-1'>
        <div className='mx-auto max-w-2xl px-8 py-10'>
          <Outlet />
        </div>
      </div>
    </div>
  )
}
