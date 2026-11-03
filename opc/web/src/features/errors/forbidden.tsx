import { ErrorPage } from './error-page'

export function ForbiddenError() {
  return (
    <ErrorPage
      code='403'
      title='没有权限看这一页'
      body='这台电脑不允许从这里访问它。'
    />
  )
}
