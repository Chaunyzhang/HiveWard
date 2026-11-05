import { expect, it } from 'vitest'
import { profileStateBuildCompatibilityError } from './profile-state-build-compatibility'
it('旧 HiveWard 1.4.214 的 SQLite 资料可交给 HiveWard 1.0.0', () => {
  expect(profileStateBuildCompatibilityError('1.4.214', '1.0.0')).toBeNull()
})
it('其他产品的较大版本不构成 HiveWard 更新', () => {
  expect(profileStateBuildCompatibilityError('1.0.0', '1.4.214', 'OtherApp')).toContain('--profile-id')
})
it.each(['0.9.0', 'invalid', '1.0.0-rc.1'])('拒绝不支持当前资料的 %s', (version) => {
  expect(profileStateBuildCompatibilityError('1.0.0', version)).toBeTruthy()
})
