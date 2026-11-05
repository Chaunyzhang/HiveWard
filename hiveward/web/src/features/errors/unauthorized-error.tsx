import { tr } from '@/lib/i18n'
import { ErrorPage } from './error-page'

export function UnauthorisedError() {
  return (
    <ErrorPage
      code='401'
      title={tr('还没通过验证')}
      body={tr('这台电脑需要先配对才能访问。')}
    />
  )
}
