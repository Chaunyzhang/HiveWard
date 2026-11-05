import { useNavigate, useRouter } from '@tanstack/react-router'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** 出错页共用的样子：大号状态码、一句话、一行说明，下面「返回上一页 / 回总览」 */
export function ErrorPage({
  code,
  title,
  body,
  minimal = false,
  className,
}: {
  code: string
  title: string
  body: string
  /** 只显示一句话，不要状态码和按钮（嵌在别的页面里时） */
  minimal?: boolean
  className?: string
}) {
  const navigate = useNavigate()
  const { history } = useRouter()
  return (
    <div className={cn('h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        {!minimal && (
          <h1 className='text-[7rem] leading-tight font-bold'>{code}</h1>
        )}
        <span className='font-medium'>{title}</span>
        <p className='text-center text-muted-foreground'>{body}</p>
        {!minimal && (
          <div className='mt-6 flex gap-4'>
            <Button variant='outline' onClick={() => history.go(-1)}>
              {tr('返回上一页')}
            </Button>
            <Button onClick={() => navigate({ to: '/' })}>
              {tr('回总览')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
