import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/** 顶栏 / 侧栏用的图标按钮（无边框，像 Claude 桌面端顶栏），带悬停提示。 */
export function IconButton({
  label,
  side = 'bottom',
  dot,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & {
  label: string
  side?: 'bottom' | 'right'
  /** 右上角提醒点 */
  dot?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          aria-label={label}
          className={cn(
            'relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent [&_svg]:size-4',
            className
          )}
          {...props}
        >
          {children}
          {dot && (
            <span className='absolute -end-0.5 -top-0.5 size-2 rounded-full bg-attention' />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
