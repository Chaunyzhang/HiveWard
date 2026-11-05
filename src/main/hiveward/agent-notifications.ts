import { app, Notification } from 'electron'
import type { HiveWardRuntimeService } from '../runtime/hiveward-runtime'
import type { Store } from '../persistence/loading-store/store'
import { mainProcessState } from '../startup/main-process-state'
import { deliverNativeNotification } from '../ipc/native-notification-delivery'
import { setTrayAttention } from '../tray/system-tray'

export function installHiveWardAgentNotifications(runtime: HiveWardRuntimeService, store: Store): void {
  // Host news already applies turn settling, workspace muting and duplicate suppression.
  const unsubscribe = runtime.onNotificationDispatched((event) => {
    if (
      event.type !== 'notification' ||
      event.source !== 'agent-task-complete' ||
      event.desktopAllowed === false ||
      event.legacySocketAllowed === false
    ) {
      return
    }
    const settings = store.getSettings().notifications
    if (!settings.enabled) {
      return
    }
    setTrayAttention(true)
    if (settings.suppressWhenFocused && mainProcessState.mainWindow?.isFocused()) {
      return
    }
    if (!Notification.isSupported()) {
      return
    }
    void deliverNativeNotification(
      {
        source: event.source,
        worktreeId: event.worktreeId,
        paneKey: event.paneKey,
        agentState: event.agentState,
        notificationId: event.notificationId
      },
      { title: event.title, body: event.body },
      settings
    )
  })
  app.once('will-quit', unsubscribe)
}
