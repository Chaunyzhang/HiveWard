import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { DecisionList } from './decision-list'
import { useDecisionsDrawer } from './drawer-context'

/** 任何页面都能从侧栏打开的待办抽屉。 */
export function DecisionsDrawer() {
  const { open, setOpen } = useDecisionsDrawer()
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className='flex w-full flex-col gap-0 p-0 sm:max-w-md'>
        <SheetHeader className='px-5 pt-5 pb-0'>
          <SheetTitle className='text-sm font-medium'>待办</SheetTitle>
          <SheetDescription className='text-xs'>
            负责人提交、需要你决定的事，按紧急度排序。
          </SheetDescription>
        </SheetHeader>
        <div className='flex-1 overflow-y-auto px-5 pt-4 pb-8'>
          <DecisionList onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
