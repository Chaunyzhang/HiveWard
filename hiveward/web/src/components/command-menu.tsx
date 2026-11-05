import React from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  Inbox,
  Laptop,
  ListChecks,
  Network,
  Moon,
  Settings,
  Sun,
} from 'lucide-react'
import { useOverview } from '@/lib/hiveward-api'
import { tr } from '@/lib/i18n'
import { useSearch } from '@/context/search-provider'
import { useTheme } from '@/context/theme-provider'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { useSettings } from '@/features/settings'
import { ScrollArea } from './ui/scroll-area'

export function CommandMenu() {
  const navigate = useNavigate()
  const showSettings = useSettings((st) => st.show)
  const { setTheme } = useTheme()
  const { open, setOpen } = useSearch()
  const { data } = useOverview()

  const run = React.useCallback(
    (command: () => unknown) => {
      setOpen(false)
      command()
    },
    [setOpen]
  )

  return (
    <CommandDialog modal open={open} onOpenChange={setOpen}>
      <CommandInput placeholder={tr('跳转到业务、页面或执行命令…')} />
      <CommandList>
        <ScrollArea type='hover' className='h-72 pe-1'>
          <CommandEmpty>{tr('没有匹配项。')}</CommandEmpty>
          <CommandGroup heading={tr('页面')}>
            <CommandItem onSelect={() => run(() => navigate({ to: '/' }))}>
              <Network /> {tr('架构图')}
            </CommandItem>
            <CommandItem onSelect={() => run(() => navigate({ to: '/tasks' }))}>
              <ListChecks /> {tr('任务')}
            </CommandItem>
            <CommandItem
              onSelect={() =>
                run(() =>
                  navigate({ to: '/tasks', search: { status: 'mine' } })
                )
              }
            >
              <Inbox /> {tr('待决策')}
            </CommandItem>

            <CommandItem onSelect={() => run(() => showSettings())}>
              <Settings /> {tr('设置')}
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading={tr('业务')}>
            {(data?.businesses ?? []).map((b) => (
              <CommandItem
                key={b.id}
                value={tr('业务 {0}', [b.name])}
                onSelect={() =>
                  run(() =>
                    navigate({
                      to: '/b/$businessId',
                      params: { businessId: b.id },
                    })
                  )
                }
              >
                <span className='w-4 text-center'>{b.icon}</span> {b.name}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading={tr('主题')}>
            <CommandItem onSelect={() => run(() => setTheme('light'))}>
              <Sun /> {tr('浅色')}
            </CommandItem>
            <CommandItem onSelect={() => run(() => setTheme('dark'))}>
              <Moon /> {tr('深色')}
            </CommandItem>
            <CommandItem onSelect={() => run(() => setTheme('system'))}>
              <Laptop /> {tr('跟随系统')}
            </CommandItem>
          </CommandGroup>
        </ScrollArea>
      </CommandList>
    </CommandDialog>
  )
}
