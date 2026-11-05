import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** 座位上的虚线小标签：外援、远程执行、来自别的电脑都用这一种，和自家的分开 */
export function SeatTag({
  className,
  title,
  children,
}: {
  className?: string
  title?: string
  children: React.ReactNode
}) {
  return (
    <span
      title={title}
      className={cn(
        'min-w-0 shrink-0 truncate rounded border border-dashed border-muted-foreground/50 px-1 text-[11px] leading-4 text-muted-foreground',
        className
      )}
    >
      {children}
    </span>
  )
}

/** 「外援」小标签：别的业务找来帮忙的 Agent（左栏会话行、架构图下属卡共用） */
export function ExternalTag({ className }: { className?: string }) {
  return <SeatTag className={className}>{tr('外援')}</SeatTag>
}
