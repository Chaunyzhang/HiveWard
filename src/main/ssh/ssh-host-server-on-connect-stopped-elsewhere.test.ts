import { describe, expect, it } from 'vitest'

import {
  withDeactivatedVersion,
  withDeactivatedVersionCommitted,
  type HivewarddActivationRecord
} from '../managed-server/activation/hivewardd-activation-record'
import { planManagedHivewarddAutoUpdate } from '../managed-server/lifecycle/hivewardd-managed-update-decision'

describe('redeploying a host another desktop stopped, across HiveWard versions', () => {
  const servedBy = (appVersion: string, active: string): HivewarddActivationRecord => ({
    schemaVersion: 1,
    active,
    activeProduct: 'HiveWard',
    activeVersionFamily: 'hiveward',
    previous: null,
    activatedAt: '2026-10-01T00:00:00.000Z',
    activeAppVersion: appVersion,
    snapshot: null
  })
  const plan = (record: HivewarddActivationRecord, appVersion: string, failedBefore = false) =>
    planManagedHivewarddAutoUpdate({
      record,
      candidateVersion: `${appVersion}+cand`,
      appVersion,
      failedBefore
    })

  it('never lets an older desktop downgrade a host a newer desktop stopped', () => {
    const stopped = withDeactivatedVersionCommitted(servedBy('1.5.0', '1.5.0+new'))
    expect(plan(stopped, '1.4.0')).toEqual({ action: 'skip', reason: 'host-newer' })
    expect(plan(stopped, '1.5.0')).toEqual({ action: 'update' })
    expect(plan(stopped, '1.6.0')).toEqual({ action: 'update' })
  })

  it('redeploys a stop recorded without the app version', () => {
    // What a stop committed by a build that predates keeping the app version leaves.
    const legacy = {
      ...withDeactivatedVersion(servedBy('1.5.0', '1.5.0+new')),
      activeProduct: 'HiveWard'
    }
    expect(plan(legacy, '1.6.0')).toEqual({ action: 'update' })
    expect(plan(legacy, '1.4.0')).toEqual({ action: 'update' })
    expect(plan(legacy, '1.4.0', true)).toEqual({ action: 'update' })
  })

  it('retries the redeploy after an earlier failure, since nothing serves', () => {
    const stopped = withDeactivatedVersionCommitted(servedBy('1.4.0', '1.4.0+old'))
    expect(plan(stopped, '1.4.0', true)).toEqual({ action: 'update' })
    // A host that still serves keeps the once-per-version suppression.
    expect(plan(servedBy('1.4.0', '1.4.0+old'), '1.5.0', true)).toEqual({
      action: 'skip',
      reason: 'failed-before'
    })
  })

  it('never reactivates a build an explicit rollback left, after a stop', () => {
    const rolledBack = { ...servedBy('1.5.0', '1.5.0+old'), rolledBackFrom: '1.5.0+cand' }
    expect(plan(withDeactivatedVersionCommitted(rolledBack), '1.5.0')).toEqual({
      action: 'skip',
      reason: 'rolled-back'
    })
  })
})
