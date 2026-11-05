import { Notification } from 'electron'
import { mainProcessState } from '../startup/main-process-state'
import { retainNotificationUntilRelease } from '../ipc/native-notification-lifecycle'
import { openInHiveWard } from './bridge-service'

type InvitationNotice = {
  machine: { name: string; address: string; user?: string }
  organization: { name: string }
}

export function notifyMachineInvitation(invite: InvitationNotice): void {
  if (mainProcessState.mainWindow?.isFocused() || !Notification.isSupported()) {
    return
  }
  const notification = new Notification({
    title: '加入 HiveWard 组织邀请',
    body: `${invite.machine.user ?? ''} · ${invite.machine.name} (${invite.machine.address}) 邀请你加入「${invite.organization.name}」。同意后成员可远程控制本机。`
  })
  const click = (): void => {
    release()
    openInHiveWard('/machines')
  }
  const release = retainNotificationUntilRelease(notification, () => {
    notification.removeListener('click', click)
  })
  notification.once('click', click)
  notification.once('failed', release)
  notification.show()
}
