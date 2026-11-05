import { expect, it, vi } from 'vitest'
import { identifyLegacyHiveWardRecord } from './legacy-hiveward-host-identity'
import {
  emptyHivewarddActivationRecord,
  withActivatedVersion,
  withRolledBackVersion
} from './hivewardd-activation-record'
import { refuseHivewarddHostDowngrade } from '../../ssh/hivewardd-host-version-admission'
const legacy = {
  ...emptyHivewarddActivationRecord(),
  active: '0.2.0+abc123',
  activeAppVersion: '1.4.214'
}
const source =
  'var product = {name:"HiveWard",appId:"local.opc.app",runtimeMetadata:"opc-runtime.json"};'
it('核对实际包中的 HiveWard 标记后才允许继承版号迁移', async () => {
  const read = vi.fn().mockResolvedValue(source)
  const identified = await identifyLegacyHiveWardRecord(legacy, read)
  expect(read).toHaveBeenCalledWith(legacy.active)
  expect(identified).toMatchObject({ activeProduct: 'HiveWard', activeVersionFamily: 'inherited' })
  expect(refuseHivewarddHostDowngrade(identified, 'new', '1.0.0')).toBeNull()
  expect(legacy).not.toHaveProperty('activeProduct')
})
it.each([
  source.replace('HiveWard', 'OtherApp'),
  source.replace('local.opc.app', 'com.example.other'),
  source.replace('opc-runtime.json', 'other-runtime.json'),
  ''
])('其他产品或缺少产品证据的包不会被覆盖', async (bundle) => {
  const identified = await identifyLegacyHiveWardRecord(legacy, vi.fn().mockResolvedValue(bundle))
  expect(identified).toBe(legacy)
  expect(refuseHivewarddHostDowngrade(identified, 'new', '1.0.0')).toBe('host-identity-unverified')
})
it('读取失败与越界安装版本都不降格成已核实的产品', async () => {
  const read = vi.fn().mockRejectedValue(new Error('unavailable'))
  expect(await identifyLegacyHiveWardRecord(legacy, read)).toBe(legacy)
  read.mockClear()
  const invalid = { ...legacy, active: '../outside' }
  expect(await identifyLegacyHiveWardRecord(invalid, read)).toBe(invalid)
  expect(read).not.toHaveBeenCalled()
})
it('已标记的其他产品不再探测，更不会因目录中有 HiveWard 字样改判', async () => {
  const record = { ...legacy, activeProduct: 'OtherApp' }
  const read = vi.fn().mockResolvedValue(source)
  expect(await identifyLegacyHiveWardRecord(record, read)).toBe(record)
  expect(read).not.toHaveBeenCalled()
  expect(refuseHivewarddHostDowngrade(record, 'new', '1.0.0')).toBe('host-other-product')
})
it('激活和回滚保留版本线，未来 HiveWard 1.4.214 不能降级', async () => {
  const identified = await identifyLegacyHiveWardRecord(legacy, vi.fn().mockResolvedValue(source))
  const next = withActivatedVersion(identified, 'new', null, new Date(0), '1.0.0')
  expect(next).toMatchObject({
    activeVersionFamily: 'hiveward',
    previousVersionFamily: 'inherited'
  })
  expect(withRolledBackVersion(next, new Date(0)).activeVersionFamily).toBe('inherited')
  const future = withActivatedVersion(next, 'future', null, new Date(0), '1.4.214')
  expect(refuseHivewarddHostDowngrade(future, 'newer-hash', '1.0.0')).toBe('host-newer')
})

it('强制更新也不能跨越产品边界', async () => {
  const { planHivewarddUpdateForIntent, admitHivewarddRecordForIntent } =
    await import('../lifecycle/hivewardd-managed-update-decision')
  for (const record of [legacy, { ...legacy, activeProduct: 'OtherApp' }]) {
    expect(
      planHivewarddUpdateForIntent('force', {
        record,
        candidateVersion: 'new',
        appVersion: '1.0.0',
        failedBefore: false
      }).action
    ).toBe('skip')
    expect(admitHivewarddRecordForIntent('force', '1.0.0')(record, 'new')).toContain('已保留原安装')
  }
})

it('旧客户端丢失新产品字段后，仍从实际新包识别正式版本线', async () => {
  const currentBundle = `${source}\nvar record = {activeVersionFamily:"hiveward"}`
  const record = await identifyLegacyHiveWardRecord(
    legacy,
    vi.fn().mockResolvedValue(currentBundle)
  )
  expect(record.activeVersionFamily).toBe('hiveward')
  expect(refuseHivewarddHostDowngrade(record, 'new', '1.0.0')).toBe('host-newer')
})

it.each([null, legacy.active])(
  '回滚目标明确属于其他产品时也不会靠源码字样改判 %s',
  async (active) => {
    const record = { ...legacy, active, previous: legacy.active, previousProduct: 'OtherApp' }
    const read = vi.fn().mockResolvedValue(source)
    expect(await identifyLegacyHiveWardRecord(record, read)).toBe(record)
    expect(read).not.toHaveBeenCalled()
    expect(refuseHivewarddHostDowngrade(record, 'new', '1.0.0')).toBe('host-other-product')
  }
)
