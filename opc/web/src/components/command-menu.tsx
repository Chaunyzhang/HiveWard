import React from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  History,
  House,
  Laptop,
  Lightbulb,
  Moon,
  Settings,
  Sun,
} from 'lucide-react'
import { useOverview } from '@/lib/opc-api'
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
import { useDecisionsDrawer } from '@/features/decisions/drawer-context'
import { ScrollArea } from './ui/scroll-area'

export function CommandMenu() {
  const navigate = useNavigate()
  const { setTheme } = useTheme()
  const { open, setOpen } = useSearch()
  const drawer = useDecisionsDrawer()
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
      <CommandInput placeholder='跳转到业务、页面或执行命令…' />
      <CommandList>
        <ScrollArea type='hover' className='h-72 pe-1'>
          <CommandEmpty>没有匹配项。</CommandEmpty>
          <CommandGroup heading='页面'>
            <CommandItem onSelect={() => run(() => navigate({ to: '/' }))}>
              <House /> 总览
            </CommandItem>
            <CommandItem
              onSelect={() => run(() => navigate({ to: '/timeline' }))}
            >
              <History /> 时间线
            </CommandItem>
            <CommandItem onSelect={() => run(() => drawer.setOpen(true))}>
              <Lightbulb /> 待我决定
            </CommandItem>
            <CommandItem
              onSelect={() => run(() => navigate({ to: '/settings' }))}
            >
              <Settings /> 设置
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading='业务'>
            {(data?.businesses ?? []).map((b) => (
              <CommandItem
                key={b.id}
                value={`业务 ${b.name}`}
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
          <CommandGroup heading='主题'>
            <CommandItem onSelect={() => run(() => setTheme('light'))}>
              <Sun /> 浅色
            </CommandItem>
            <CommandItem onSelect={() => run(() => setTheme('dark'))}>
              <Moon /> 深色
            </CommandItem>
            <CommandItem onSelect={() => run(() => setTheme('system'))}>
              <Laptop /> 跟随系统
            </CommandItem>
          </CommandGroup>
        </ScrollArea>
      </CommandList>
    </CommandDialog>
  )
}
