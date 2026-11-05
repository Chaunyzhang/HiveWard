import { describe, expect, it } from 'vitest'
import {
  HivewarddManagedStopCancellationSchema,
  HivewarddManagedStopCompletionSchema
} from './hivewardd-stop-request'

const request = {
  schemaVersion: 1,
  transactionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  version: '1.0.0',
  runtimeId: 'runtime-1',
  instance: { pid: 42, startedAtMs: null, nonce: 'nonce', lockPath: '/tmp/lock' }
}

describe('managed stop replies from a newer slot', () => {
  it('degrade unknown arms and ignore unknown fields', () => {
    const newer = { ...request, instance: { ...request.instance, futureField: 1 }, futureField: 1 }

    expect(
      HivewarddManagedStopCompletionSchema.parse({
        ...newer,
        kind: 'hivewardd_managed_stop_completion',
        verdict: 'future-verdict',
        receiptPersisted: true,
        retirement: 'future-retirement'
      })
    ).toMatchObject({ verdict: 'unverifiable', retirement: 'unverifiable' })
    expect(
      HivewarddManagedStopCancellationSchema.parse({
        ...newer,
        kind: 'hivewardd_managed_stop_cancellation',
        outcome: 'future-outcome'
      })
    ).toMatchObject({ outcome: 'dispatched' })
  })

  it('still rejects a missing verdict', () => {
    expect(() =>
      HivewarddManagedStopCompletionSchema.parse({
        ...request,
        kind: 'hivewardd_managed_stop_completion',
        receiptPersisted: true
      })
    ).toThrow()
  })
})
