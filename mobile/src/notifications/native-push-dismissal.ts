import type { HiveWardPushPayload } from './push-payload'

export type NativeDismissal = {
  rememberAll(payloads: readonly HiveWardPushPayload[]): Promise<void>
  wasDismissed(payload: HiveWardPushPayload): Promise<boolean>
}
// Android and web use JavaScript storage; iOS requires the native ledger.
export const nativePushDismissal: NativeDismissal | null = null
