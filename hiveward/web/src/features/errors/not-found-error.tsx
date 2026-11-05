import { tr } from '@/lib/i18n'
import { ErrorPage } from './error-page'

export function NotFoundError() {
  return (
    <ErrorPage
      code='404'
      title={tr('没有这个页面')}
      body={tr('它可能被移走了，或者地址打错了。')}
    />
  )
}
