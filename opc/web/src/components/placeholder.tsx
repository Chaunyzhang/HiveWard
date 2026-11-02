/** 尚未实现的页面：写清楚这一页将来做什么、在哪一期。 */
export function Placeholder({
  title,
  phase,
  children,
}: {
  title: string
  phase: string
  children: React.ReactNode
}) {
  return (
    <div className='panel rounded-xl p-8'>
      <div className='flex items-center gap-3'>
        <h2 className='text-sm font-medium'>{title}</h2>
        <span className='rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
          {phase}
        </span>
      </div>
      <p className='mt-2 max-w-xl text-sm text-muted-foreground'>{children}</p>
    </div>
  )
}
