import { expect, it } from 'vitest'
import { PushNotificationSchema } from '@hiveward-cloud/push-contract'
import { buildPushDelivery, HivewarddataStrings } from './push-delivery-message.js'

const base = {
  notificationSeq: 1,
  notificationEpoch: 'epoch',
  source: 'agent-task-complete',
  agentState: 'finished',
  title: 'Done',
  body: '',
  worktreeId: 'repo-1::/srv/work'
}

it('carries the workspace server to APNs and FCM, and accepts older messages without one', () => {
  const executionHost = 'runtime:env%201'
  for (const extra of [{}, { executionHost }]) {
    const delivery = buildPushDelivery({
      notification: PushNotificationSchema.parse({ ...base, ...extra }),
      hostFingerprint: 'host',
      registrationId: 'phone',
      expiresAt: Date.now() + 300000
    })
    const expected = 'executionHost' in extra ? executionHost : undefined
    expect(delivery.hiveward.executionHost).toBe(expected)
    expect(HivewarddataStrings(delivery.hiveward).executionHost).toBe(expected)
  }
})

it('accepts only runtime execution hosts', () => {
  const invalid = ['local', 'ssh:box', 'runtime:', 'runtime:a|b', `runtime:${'x'.repeat(2048)}`]
  for (const executionHost of invalid) {
    expect(PushNotificationSchema.safeParse({ ...base, executionHost }).success).toBe(false)
  }
})
