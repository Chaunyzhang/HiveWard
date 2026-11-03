import { ErrorPage } from './error-page'

export function UnauthorisedError() {
  return (
    <ErrorPage
      code='401'
      title='还没通过验证'
      body='这台电脑需要先配对才能访问。'
    />
  )
}
