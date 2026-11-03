import { cn } from '@/lib/utils'

/** 内容区容器：统一的边距和最大宽度。 */
export function Page({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-[1400px] px-6 py-8 @4xl:px-10',
        className
      )}
      {...props}
    />
  )
}

/**
 * 页标题：所有页面同一个位置、同一个字号（和业务主页的标题对齐），切页面时不跳。
 * 下面一行小字说明；右边放这页的操作（筛选、按钮）。
 */
export function PageTitle({
  title,
  subtitle,
  actions,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className='flex min-h-10 items-start gap-3'>
      <div className='min-w-0 flex-1'>
        <h1 className='truncate text-lg font-semibold'>{title}</h1>
        {subtitle && (
          <p className='truncate text-xs text-muted-foreground'>{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className='flex shrink-0 items-center gap-2'>{actions}</div>
      )}
    </div>
  )
}
