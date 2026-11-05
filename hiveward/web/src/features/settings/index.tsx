import { useEffect, useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import {
  Bot,
  Gauge,
  Info,
  Laptop,
  RefreshCw,
  Search,
  Settings2,
  Share2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { create } from 'zustand'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsAbout } from './about'
import { SettingsAgents } from './agents'
import { SettingsGeneral } from './general'
import { SettingsMachine } from './machine'
import { SettingsSharing } from './sharing'
import { SettingsUpdates } from './updates'
import { SettingsUsage } from './usage'

type Section =
  | 'general'
  | 'usage'
  | 'machine'
  | 'agents'
  | 'sharing'
  | 'updates'
  | 'about'

const groups: {
  label: string
  items: {
    id: Section
    title: string
    icon: LucideIcon
    page: React.ComponentType
  }[]
}[] = [
  {
    label: tr('偏好'),
    items: [
      {
        id: 'general',
        title: tr('常规'),
        icon: Settings2,
        page: SettingsGeneral,
      },
      { id: 'usage', title: tr('用量'), icon: Gauge, page: SettingsUsage },
    ],
  },
  {
    label: tr('此电脑'),
    items: [
      {
        id: 'machine',
        title: tr('这台电脑'),
        icon: Laptop,
        page: SettingsMachine,
      },
      {
        id: 'agents',
        title: tr('本机 Agent'),
        icon: Bot,
        page: SettingsAgents,
      },
      { id: 'sharing', title: tr('共享'), icon: Share2, page: SettingsSharing },
    ],
  },
  {
    label: 'HiveWard',
    items: [
      {
        id: 'updates',
        title: tr('版本更新'),
        icon: RefreshCw,
        page: SettingsUpdates,
      },
      { id: 'about', title: tr('关于'), icon: Info, page: SettingsAbout },
    ],
  },
]
const items = groups.flatMap((g) => g.items)
const isSection = (s: string | undefined): s is Section =>
  items.some((i) => i.id === s)

export const useSettings = create<{
  open: boolean
  section: Section
  show: (section?: string) => void
  close: () => void
}>((set) => ({
  open: false,
  section: 'general',
  show: (section) =>
    set((s) => ({
      open: true,
      section: isSection(section) ? section : s.section,
    })),
  close: () => set({ open: false }),
}))

/**
 * 设置：一个单独的弹窗（照 Claude 桌面端的设置），浮在当前页面上，关掉回到原处。
 * 左边搜索 + 分组导航，右边一页一页的设置；有什么放什么，不硬凑。
 */
export function SettingsDialog() {
  const open = useSettings((s) => s.open)
  const section = useSettings((s) => s.section)
  const show = useSettings((s) => s.show)
  const close = useSettings((s) => s.close)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const page = items.find((i) => i.id === section) ?? items[0]
  const Page = page.page
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        showCloseButton={false}
        className='flex h-[min(760px,88vh)] w-[min(1040px,92vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none'
      >
        <header className='flex h-12 shrink-0 items-center border-b ps-5 pe-3'>
          <DialogTitle className='text-[15px] font-semibold'>
            {tr('设置')}
          </DialogTitle>
          <DialogClose
            aria-label={tr('关闭')}
            className='ms-auto grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
          >
            <X className='size-4' />
          </DialogClose>
        </header>
        <div className='flex min-h-0 flex-1'>
          <aside className='w-56 shrink-0 space-y-5 overflow-y-auto border-e px-3 py-4'>
            <label className='flex h-8 items-center gap-2 rounded-md border bg-muted/40 px-2.5 text-[13px] focus-within:ring-1 focus-within:ring-ring'>
              <Search className='size-3.5 text-muted-foreground' />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tr('搜索')}
                className='min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground'
              />
            </label>
            {groups.map((g) => {
              const shown = g.items.filter(
                (i) => !q || i.title.toLowerCase().includes(q)
              )
              if (!shown.length) {
                return null
              }
              return (
                <div key={g.label}>
                  <p className='px-3 pb-1.5 text-xs text-muted-foreground'>
                    {g.label}
                  </p>
                  <nav className='space-y-0.5'>
                    {shown.map((item) => (
                      <button
                        key={item.id}
                        type='button'
                        onClick={() => show(item.id)}
                        className={cn(
                          'flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[13px] text-foreground/80 hover:bg-accent hover:text-foreground',
                          item.id === page.id &&
                            'bg-accent font-medium text-foreground'
                        )}
                      >
                        <item.icon className='size-4 shrink-0' />
                        {item.title}
                      </button>
                    ))}
                  </nav>
                </div>
              )
            })}
          </aside>
          <div className='min-w-0 flex-1 overflow-y-auto'>
            <div className='mx-auto max-w-2xl px-8 py-8'>
              <Page />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * /settings、/settings/<页> 这类地址（App 菜单「设置…」、旧书签）：打开设置弹窗，再回到原来的页面。
 */
export function SettingsRoute() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const show = useSettings((s) => s.show)
  const navigate = useNavigate()
  useEffect(() => {
    show(pathname.split('/')[2])
    if (window.history.length > 1) {
      window.history.back()
    } else {
      void navigate({ to: '/', replace: true })
    }
  }, [pathname, show, navigate])
  return null
}
