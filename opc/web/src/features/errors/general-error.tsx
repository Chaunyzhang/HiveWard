import { ErrorPage } from './error-page'

export function GeneralError({
  className,
  minimal = false,
}: React.HTMLAttributes<HTMLDivElement> & {
  minimal?: boolean
}) {
  return (
    <ErrorPage
      code='500'
      title='出错了'
      body='页面遇到了问题，刷新一下再试。'
      minimal={minimal}
      className={className}
    />
  )
}
