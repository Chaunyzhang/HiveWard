import { Notification } from 'electron'
import { retainNotificationUntilRelease } from '../ipc/native-notification-lifecycle'
import { openInHiveWard } from './bridge-service'

export function notifyExitRegionWarning(warning: { message: string }): void {
  if (!Notification.isSupported()) {
    return
  }
  const notification = new Notification({ title: 'Agent 出口地区警告', body: warning.message })
  const click = (): void => {
    release()
    openInHiveWard('/machines')
  }
  const release = retainNotificationUntilRelease(notification, () =>
    notification.removeListener('click', click)
  )
  notification.once('click', click)
  notification.once('failed', release)
  notification.show()
}
