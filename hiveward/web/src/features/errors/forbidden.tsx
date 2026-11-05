import { tr } from '@/lib/i18n'
import { ErrorPage } from './error-page'

export function ForbiddenError() {
  return (
    <ErrorPage
      code='403'
      title={tr('没有权限看这一页')}
      body={tr('这台电脑不允许从这里访问它。')}
    />
  )
}
