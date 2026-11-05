import { describe, expect, it } from 'vitest'
import {
  emptyHivewarddActivationRecord,
  type HivewarddActivationRecord
} from '../activation/hivewardd-activation-record'
import {
  admitHivewarddRecordForIntent,
  availableManagedHivewarddUpdate,
  planHivewarddUpdateForIntent
} from './hivewardd-managed-update-decision'

const rolledBack = {
  ...emptyHivewarddActivationRecord(),
  active: '1.4.0+aa',
  activeProduct: 'HiveWard',
  activeAppVersion: '1.4.0',
  rolledBackFrom: '1.5.0+ab'
}
const newer = {
  ...emptyHivewarddActivationRecord(),
  activeProduct: 'HiveWard',
  active: '2.0.0+cd',
  activeAppVersion: '2.0.0'
}
const input = { candidateVersion: '1.5.0+ab', appVersion: '1.5.0', failedBefore: true }

describe('the three update intents', () => {
  it('skips a build this host refused on a connect only', () => {
    expect(planHivewarddUpdateForIntent('connect', { ...input, record: rolledBack })).toEqual({
      action: 'skip',
      reason: 'rolled-back'
    })
    expect(planHivewarddUpdateForIntent('update', { ...input, record: rolledBack })).toEqual({
      action: 'update'
    })
    expect(planHivewarddUpdateForIntent('force', { ...input, record: rolledBack })).toEqual({
      action: 'update'
    })
  })

  it('keeps a newer host on Update, and lifts it only on Force', () => {
    expect(planHivewarddUpdateForIntent('update', { ...input, record: newer })).toEqual({
      action: 'skip',
      reason: 'host-newer'
    })
    expect(admitHivewarddRecordForIntent('update', '1.5.0')(newer, '1.5.0+ab')).toMatch(
      /HiveWard 2\.0\.0 last ran/
    )
    expect(admitHivewarddRecordForIntent('force', '1.5.0')(newer, '1.5.0+ab')).toBeNull()
    expect(admitHivewarddRecordForIntent('update', '1.5.0')(rolledBack, '1.5.0+ab')).toBeNull()
  })
})

describe('the Update offered for a running host', () => {
  const running = {
    ...emptyHivewarddActivationRecord(),
    activeProduct: 'HiveWard',
    active: '0.1.0+aa',
    activeAppVersion: '1.4.0'
  }
  const offer = (
    record: HivewarddActivationRecord,
    appVersion = '1.5.0',
    candidateVersion = '0.1.0+ab'
  ) =>
    availableManagedHivewarddUpdate({
      record,
      candidateVersion,
      appVersion,
      deferredCandidateVersion: null
    })

  it('offers this build only when it is not older than the HiveWard that runs the host', () => {
    expect(offer(running)).toBe('0.1.0+ab')
    expect(offer(running, '1.4.0')).toBe('0.1.0+ab')
    expect(offer(running, '1.3.9')).toBeNull()
    expect(offer({ ...running, activeAppVersion: '2.0.0' })).toBeNull()
  })

  it('offers nothing it cannot order, nothing current, and nothing the user rolled back from', () => {
    const { activeAppVersion: _unnamed, ...unnamed } = running
    expect(offer(unnamed)).toBeNull()
    const deferredOn = (deferredCandidateVersion: string) =>
      availableManagedHivewarddUpdate({
        record: unnamed,
        candidateVersion: '0.1.0+ab',
        appVersion: '1.5.0',
        deferredCandidateVersion
      })
    // A host older than the version field: only the build this desktop already tried.
    expect(deferredOn('0.1.0+ab')).toBe('0.1.0+ab')
    expect(deferredOn('0.1.0+zz')).toBeNull()
    expect(offer(running, '1.5.0', '0.1.0+aa')).toBeNull()
    expect(offer({ ...running, active: null })).toBeNull()
    expect(offer({ ...running, rolledBackFrom: '0.1.0+ab' })).toBeNull()
    expect(
      availableManagedHivewarddUpdate({
        record: running,
        candidateVersion: null,
        appVersion: '1.5.0',
        deferredCandidateVersion: null
      })
    ).toBeNull()
  })
})
