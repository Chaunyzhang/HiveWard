import { cn } from '@/lib/utils'

/** 内容区容器：统一的边距和最大宽度。 */
export function Page({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-[1400px] px-6 py-8 lg:px-10',
        className
      )}
      {...props}
    />
  )
}
