import { tr } from '@/lib/i18n'
import { ErrorPage } from './error-page'

export function MaintenanceError() {
  return (
    <ErrorPage
      code='503'
      title={tr('HiveWard 暂时连不上')}
      body={tr('后台在重启或者没开，稍后再试。')}
    />
  )
}
