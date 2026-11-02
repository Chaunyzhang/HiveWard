import { mainProcessState } from '../startup/main-process-state'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { Notification } from 'electron'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { openInHiveWard } from '../opc/bridge-service'
import type { buildNotificationOptions } from './notification-options'
import { getEffectiveNotificationSoundId } from './notification-sound-selection'
import { macosNotificationIdentity } from './macos-notification-center'
import {
  activeNotificationsById,
  logNativeNotificationFailure,
  retainNotificationUntilRelease,
  waitForNotificationDisplay
} from './native-notification-lifecycle'
import { recordNotificationDeliveryOutcome } from './notification-permission-probe'

export function deliverNativeNotification(
  args: NotificationDispatchRequest,
  notificationOptions: ReturnType<typeof buildNotificationOptions>,
  settings: NotificationSettings
): NotificationDispatchResult | Promise<NotificationDispatchResult> {
  if (getEffectiveNotificationSoundId(settings) !== 'system') {
    notificationOptions.silent = true
  }
  const notification = new Notification({
    ...notificationOptions,
    ...macosNotificationIdentity(args)
  })
  if (args.notificationId) {
    const previous = activeNotificationsById.get(args.notificationId)
    if (previous) {
      previous.notification.close()
      previous.release()
    }
  }

  // Retain the notification and click handler through display lifetime.
  let clickHandler: (() => void) | null = null
  let failedHandler: ((_event: unknown, error?: string) => void) | null = null
  const entryForId: { notification: Notification; release: () => void } | null = args.notificationId
    ? { notification, release: () => {} }
    : null
  const release = retainNotificationUntilRelease(notification, () => {
    if (clickHandler) {
      notification.removeListener('click', clickHandler)
      clickHandler = null
    }
    if (failedHandler) {
      notification.removeListener('failed', failedHandler)
      failedHandler = null
    }
    if (args.notificationId && activeNotificationsById.get(args.notificationId) === entryForId) {
      activeNotificationsById.delete(args.notificationId)
    }
  })
  if (entryForId && args.notificationId) {
    entryForId.release = release
    activeNotificationsById.set(args.notificationId, entryForId)
  }

  failedHandler = (_event, error) => {
    // Release immediately on macOS delivery/signing failure instead of waiting for retention expiry.
    logNativeNotificationFailure(args.source, error)
    // Feed permission-card fallback evidence.
    recordNotificationDeliveryOutcome('failed')
    release()
  }
  notification.on('failed', failedHandler)

  const worktreeId = args.worktreeId
  if (worktreeId) {
    clickHandler = () => {
      release()
      const scope = parseWorkspaceKey(worktreeId)
      const worktreePath =
        scope?.type === 'folder'
          ? mainProcessState.store
              ?.getFolderWorkspaces()
              .find((folder) => folder.id === scope.folderWorkspaceId)?.folderPath
          : splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
      if (worktreePath) {
        openInHiveWard(`/go?path=${encodeURIComponent(worktreePath)}`)
      }
    }
    notification.on('click', clickHandler)
  }

  const displayConfirmation = args.requireDisplayConfirmation
    ? waitForNotificationDisplay(notification)
    : null
  notification.show()

  if (displayConfirmation) {
    return displayConfirmation.then((displayed) => {
      if (!displayed) {
        release()
        return { delivered: false, reason: 'not-displayed' }
      }
      recordNotificationDeliveryOutcome('delivered')
      return { delivered: true }
    })
  }

  return { delivered: true }
}
