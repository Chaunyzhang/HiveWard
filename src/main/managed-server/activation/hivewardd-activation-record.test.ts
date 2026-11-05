import { describe, expect, it } from 'vitest'

import {
  emptyHivewarddActivationRecord,
  hivewarddGcPinnedDirNames,
  parseHivewarddActivationRecord,
  serializeHivewarddActivationRecord,
  withActivatedVersion,
  withDeactivatedVersionCommitted,
  withRolledBackVersion,
  type HivewarddStateSnapshot
} from './hivewardd-activation-record'
import { sameHivewarddActivationRecord } from './hivewardd-activation-transaction'

const SNAPSHOT: HivewarddStateSnapshot = {
  dirName: 'pre-0.2.0+bb01-1000',
  takenBeforeVersion: '0.2.0+bb01',
  readableByVersion: '0.1.0+aa01',
  takenAt: '2026-01-01T00:00:00.000Z'
}
const NOW = new Date('2026-01-02T00:00:00.000Z')

describe('hivewardd activation record', () => {
  it('reports a newer schema as unreadable, never as absent', () => {
    const parsed = parseHivewarddActivationRecord(JSON.stringify({ schemaVersion: 2, active: 'x' }))
    expect(parsed.state).toBe('unreadable')
  })

  it('reports corrupt JSON as unreadable, never as absent', () => {
    expect(parseHivewarddActivationRecord('{not json').state).toBe('unreadable')
  })

  it('does not let a re-deploy of the active version erase the rollback target', () => {
    const before = {
      ...emptyHivewarddActivationRecord(),
      active: '0.2.0+bb01',
      previous: '0.1.0+aa01',
      snapshot: SNAPSHOT
    }
    const after = withActivatedVersion(before, '0.2.0+bb01', null, NOW)
    expect(after).toMatchObject({ active: '0.2.0+bb01', previous: '0.1.0+aa01' })
    expect(after.snapshot).toEqual(SNAPSHOT)
  })

  it('clears the rollback target after rolling back, so it cannot walk into the bad build', () => {
    const before = {
      ...emptyHivewarddActivationRecord(),
      active: '0.2.0+bb01',
      previous: '0.1.0+aa01',
      snapshot: SNAPSHOT
    }
    expect(withRolledBackVersion(before, NOW)).toMatchObject({
      active: '0.1.0+aa01',
      previous: null,
      snapshot: null
    })
  })

  it('pins the active version, the rollback target and the live daemon"s bundle against GC', () => {
    const pinned = hivewarddGcPinnedDirNames(
      {
        ...emptyHivewarddActivationRecord(),
        active: '0.3.0+cc01',
        previous: '0.2.0+bb01'
      },
      '0.1.0+aa01'
    )
    expect(pinned).toEqual(['hivewardd-0.3.0+cc01', 'hivewardd-0.2.0+bb01', 'hivewardd-0.1.0+aa01'])
  })

  it('records which HiveWard activated each version, and the build a rollback left', () => {
    const first = withActivatedVersion(
      emptyHivewarddActivationRecord(),
      '0.1.0+aa01',
      null,
      NOW,
      '1.4.0'
    )
    const second = withActivatedVersion(first, '0.2.0+bb01', SNAPSHOT, NOW, '1.5.0')
    expect(second).toMatchObject({ activeAppVersion: '1.5.0', previousAppVersion: '1.4.0' })
    expect(parseHivewarddActivationRecord(serializeHivewarddActivationRecord(second))).toEqual({
      state: 'ok',
      record: second
    })
    const rolledBack = withRolledBackVersion(second, NOW)
    expect(rolledBack).toMatchObject({
      active: '0.1.0+aa01',
      activeAppVersion: '1.4.0',
      rolledBackFrom: '0.2.0+bb01'
    })
    expect(withActivatedVersion(rolledBack, '0.3.0+cc01', null, NOW, '1.6.0')).not.toHaveProperty(
      'rolledBackFrom'
    )
  })

  it('names no previous app version when activating over a stopped host', () => {
    const served = withActivatedVersion(
      emptyHivewarddActivationRecord(),
      '0.1.0+aa01',
      null,
      NOW,
      '1.5.0'
    )
    const stopped = withDeactivatedVersionCommitted(served)
    expect(stopped).toMatchObject({
      active: null,
      previous: '0.1.0+aa01',
      activeAppVersion: '1.5.0'
    })
    const redeployed = withActivatedVersion(stopped, '0.2.0+bb01', null, NOW, '1.6.0')
    expect(redeployed).toMatchObject({ previous: null, activeAppVersion: '1.6.0' })
    expect(redeployed).not.toHaveProperty('previousAppVersion')
  })

  it('matches a journal from a build that drops the advisory fields', () => {
    const current = withActivatedVersion(
      emptyHivewarddActivationRecord(),
      '0.1.0+aa01',
      null,
      NOW,
      '1.5.0'
    )
    const { activeAppVersion: _dropped, ...older } = current
    expect(sameHivewarddActivationRecord(current, older)).toBe(true)
    expect(sameHivewarddActivationRecord(current, { ...older, active: '0.2.0+bb01' })).toBe(false)
  })
})

it('停止、重新激活与回滚不会丢失产品来源', () => {
  const old = {
    ...emptyHivewarddActivationRecord(),
    active: 'old',
    activeAppVersion: '1.4.214',
    activeProduct: 'HiveWard'
  }
  expect(withDeactivatedVersionCommitted(old).activeProduct).toBe('HiveWard')
  const first = withActivatedVersion(emptyHivewarddActivationRecord(), 'first', null, NOW, '1.0.0')
  const next = withActivatedVersion(first, 'next', null, NOW, '1.1.0')
  expect(next).toMatchObject({ activeProduct: 'HiveWard', previousProduct: 'HiveWard' })
  expect(withRolledBackVersion(next, NOW)).toMatchObject({
    activeProduct: 'HiveWard',
    activeAppVersion: '1.0.0'
  })
  expect(withActivatedVersion(next, 'next', null, NOW, '1.1.0').previousProduct).toBe('HiveWard')
})
