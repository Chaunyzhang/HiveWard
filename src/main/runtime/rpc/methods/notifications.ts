import { createNotificationStreamFilter } from './notification-stream-policy'
import { defineStreamingMethod, defineMethod, type RpcContext } from '../core'
import type { HiveWardRuntimeService } from '../../hiveward-runtime'
import {
  NotificationGetMissedSinceParams,
  NotificationReportDesktopPresenceParams,
  NotificationUnsubscribeParams,
  NotificationsSubscribeParams
} from '../../../../shared/rpc-contract/notifications-params'

// Use a per-process counter so same-millisecond subscriptions cannot collide.
let notificationsSubscriptionSeq = 0

type DesktopPresenceReportContext = Pick<RpcContext, 'clientKind' | 'connectionId' | 'signal'> & {
  runtime: Pick<HiveWardRuntimeService, 'reportDesktopClientPresence' | 'registerSubscriptionCleanup'>
}

/** Only a paired desktop's own socket speaks for a desktop; the report lives as long as it. */
export function reportDesktopPresence(
  params: { away: boolean },
  { runtime, clientKind, connectionId, signal }: DesktopPresenceReportContext
): { recorded: boolean } {
  // A closed socket already ran its cleanups, so a late report would never be forgotten.
  if (clientKind !== 'runtime' || !connectionId || signal?.aborted) {
    return { recorded: false }
  }
  runtime.reportDesktopClientPresence(connectionId, params.away, (forget) =>
    runtime.registerSubscriptionCleanup(`desktop-presence-${connectionId}`, forget, connectionId)
  )
  return { recorded: true }
}

// Legacy callers retain filtered socket alerts; push clients opt into the full event stream.
export const NOTIFICATION_METHODS = [
  defineStreamingMethod({
    name: 'notifications.subscribe',
    permission: 'workspace',
    params: NotificationsSubscribeParams,
    handler: async (params, { runtime, connectionId }, emit) => {
      const shouldEmit = createNotificationStreamFilter(params?.includeDesktopSuppressed)
      await new Promise<void>((resolve) => {
        const unsubscribe = runtime.onNotificationDispatched((event) => {
          if (shouldEmit(event)) {
            emit(event)
          }
        })

        // Key cleanup by socket plus sequence so concurrent subscriptions cannot evict each other.
        const seq = ++notificationsSubscriptionSeq
        const subscriptionId = `notifications-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )

        // Send epoch before the reconnect watermark so getMissedSince knows the counter lifetime (#8591).
        emit({ type: 'ready', subscriptionId, epoch: runtime.getMobileNotificationEpoch() })
      })
    }
  }),
  defineMethod({
    name: 'notifications.unsubscribe',
    permission: 'workspace',
    params: NotificationUnsubscribeParams,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'notifications.getMissedSince',
    permission: 'workspace',
    params: NotificationGetMissedSinceParams,
    // Runtime sequence/epoch is authoritative for notifications missed while the socket was reaped.
    handler: async (params, { runtime }) => {
      const missed = runtime.getMissedNotificationsSince(params.lastSeenSeq, params.epoch)
      return {
        notifications: missed.filter(
          createNotificationStreamFilter(params.includeDesktopSuppressed)
        ),
        epoch: runtime.getMobileNotificationEpoch(),
        ...(params.deliveredPushes
          ? { dismissedPushes: runtime.reconcileDismissedPushes(params.deliveredPushes) }
          : {})
      }
    }
  }),
  defineMethod({
    name: 'notifications.reportDesktopPresence',
    permission: 'workspace',
    params: NotificationReportDesktopPresenceParams,
    handler: async (params, context) => reportDesktopPresence(params, context)
  })
]
