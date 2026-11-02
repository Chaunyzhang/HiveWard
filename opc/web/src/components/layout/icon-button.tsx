import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/** 顶栏 / 侧栏用的圆形图标按钮，带悬停提示。 */
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
            'relative flex size-8 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4',
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
