import type { HiveWardRuntimeService } from './hiveward-runtime'
import {
  checkBoundMailbox,
  type MailboxCheckOptions
} from './orchestration-mailbox-notification-test-harness'

/** Acknowledge a held Delivery, then take the next batch with a plain check, as agents do. */
export async function ackThenCheck(
  runtime: HiveWardRuntimeService,
  deliveryId: string,
  options: MailboxCheckOptions = {}
) {
  await checkBoundMailbox(runtime, { ...options, ack: deliveryId })
  return checkBoundMailbox(runtime, options)
}
