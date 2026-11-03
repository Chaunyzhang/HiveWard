import { ErrorPage } from './error-page'

export function MaintenanceError() {
  return (
    <ErrorPage
      code='503'
      title='HiveWard 暂时连不上'
      body='后台在重启或者没开，稍后再试。'
    />
  )
}
