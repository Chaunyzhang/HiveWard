import { cn } from '@/lib/utils'

/** 设置页的大标题（一页一个），下面是一行行设置 */
export function SettingsTitle({ children }: { children: React.ReactNode }) {
  return <h1 className='mb-4 text-lg font-semibold'>{children}</h1>
}

/** 一页里再分组时的小标题 */
export function SettingsGroup({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className='mt-10 first:mt-0'>
      <h2 className='mb-1 text-[15px] font-semibold'>{title}</h2>
      {children}
    </section>
  )
}

/**
 * 一行设置：左边标题和说明，右边控件；行与行之间一条细线，不套框。
 * below 放在这一行下面的内容（列表、输入框），和标题对齐。
 */
export function SettingRow({
  title,
  desc,
  control,
  below,
  className,
}: {
  title: React.ReactNode
  desc?: React.ReactNode
  control?: React.ReactNode
  below?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('border-b py-5 last:border-b-0', className)}>
      <div className='flex items-start gap-6'>
        <div className='min-w-0 flex-1'>
          <p className='text-[14px]'>{title}</p>
          {desc && (
            <div className='mt-1 text-[13px] leading-5 text-muted-foreground'>
              {desc}
            </div>
          )}
        </div>
        {control && <div className='shrink-0 pt-0.5'>{control}</div>}
      </div>
      {below && <div className='mt-3'>{below}</div>}
    </div>
  )
}
