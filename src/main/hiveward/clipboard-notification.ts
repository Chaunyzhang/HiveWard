import { Notification } from 'electron'
import { retainNotificationUntilRelease } from '../ipc/native-notification-lifecycle'
import { openInHiveWard } from './bridge-service'

type ClipboardNotice = {
  type: 'files_too_large'
  machine: { name: string }
  count: number
  bytes: number
}

export function notifyClipboardNotice(notice: ClipboardNotice): void {
  if (process.env.HIVEWARD_BACKGROUND_LAUNCH === '1' || !Notification.isSupported()) {
    return
  }
  const notification = new Notification({
    title: '跨电脑剪贴板文件过大',
    body: `${notice.machine.name} · ${notice.count} 个文件 · ${notice.bytes} 字节`
  })
  const click = (): void => {
    release()
    openInHiveWard('/files')
  }
  const release = retainNotificationUntilRelease(notification, () => {
    notification.removeListener('click', click)
  })
  notification.once('click', click)
  notification.once('failed', release)
  notification.show()
}
