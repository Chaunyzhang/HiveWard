import { expect, it } from 'vitest'
import { refuseHivewarddHostDowngrade } from './hivewardd-host-version-admission'
import { emptyHivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'
import { availableManagedHivewarddUpdate } from '../managed-server/lifecycle/hivewardd-managed-update-decision'
const legacy = {
  ...emptyHivewarddActivationRecord(),
  active: 'old',
  activeAppVersion: '1.4.214',
  activeProduct: 'HiveWard',
  activeVersionFamily: 'inherited' as const
}
it('旧 HiveWard 1.4.214 可更新到独立版本线的 1.0.0', () => {
  expect(refuseHivewarddHostDowngrade(legacy, 'new', '1.0.0')).toBeNull()
  expect(
    availableManagedHivewarddUpdate({
      record: legacy,
      candidateVersion: 'new',
      appVersion: '1.0.0',
      deferredCandidateVersion: null
    })
  ).toBe('new')
})
it('不同产品记录不能被当作 HiveWard 新版或覆盖目标', () => {
  const record = { ...legacy, activeProduct: 'OtherApp' }
  expect(refuseHivewarddHostDowngrade(record, 'new', '1.0.0')).toBe('host-other-product')
  expect(
    availableManagedHivewarddUpdate({
      record,
      candidateVersion: 'new',
      appVersion: '1.0.0',
      deferredCandidateVersion: null
    })
  ).toBeNull()
})
it('已标明产品的 HiveWard 版本仍然防止真正降级', () => {
  expect(
    refuseHivewarddHostDowngrade(
      {
        ...legacy,
        activeProduct: 'HiveWard',
        activeAppVersion: '1.1.0',
        activeVersionFamily: 'hiveward'
      },
      'new',
      '1.0.0'
    )
  ).toBe('host-newer')
})

it('未核实来源的旧记录不自动覆盖，未来正式版的相同数字仍防降级', () => {
  expect(
    refuseHivewarddHostDowngrade(
      { ...legacy, activeProduct: undefined, activeVersionFamily: undefined },
      'new',
      '1.0.0'
    )
  ).toBe('host-identity-unverified')
  expect(
    refuseHivewarddHostDowngrade({ ...legacy, activeVersionFamily: 'hiveward' }, 'new', '1.0.0')
  ).toBe('host-newer')
})
