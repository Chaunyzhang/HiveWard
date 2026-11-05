import { expect, it } from 'vitest'
import { readNativeNotificationData } from './native-notification-data'
import { readHiveWardPushPayload } from './push-payload'

it('reads actual Expo APNs payloads when content.data is null', () => {
  const hiveward = {
    hostFingerprint: 'qa-host',
    notificationId: 'done',
    notificationSeq: 4,
    notificationEpoch: 'epoch'
  }
  const data = readNativeNotificationData({
    content: { data: null },
    trigger: { type: 'push', payload: { aps: {}, hiveward } }
  })
  expect(readHiveWardPushPayload(data)).toMatchObject(hiveward)
})
it('keeps Android push and local notification data', () => {
  const data = { hostId: 'host', notificationId: 'done' }
  expect(readNativeNotificationData({ content: { data }, trigger: { type: 'push' } })).toBe(data)
  expect(readNativeNotificationData({ content: { data }, trigger: null })).toBe(data)
})
