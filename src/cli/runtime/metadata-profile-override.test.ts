import { afterEach, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { getDefaultUserDataPath } from './metadata'

afterEach(() => {
  vi.unstubAllEnvs()
})
it('显式资料路径覆盖父终端的默认实例，保留 HIVEWARD 环境变量兼容', () => {
  vi.stubEnv('HIVEWARD_USER_DATA_PATH', '/tmp/hiveward-parent')
  vi.stubEnv('HIVEWARD_USER_DATA_PATH', '/tmp/hiveward-isolated-test')
  expect(getDefaultUserDataPath()).toBe(resolve('/tmp/hiveward-isolated-test'))
  vi.stubEnv('HIVEWARD_USER_DATA_PATH', 'relative-test-profile')
  expect(getDefaultUserDataPath()).toBe(resolve('relative-test-profile'))
})
it('未指定显式资料时仍使用 HiveWard 提供的默认实例', () => {
  vi.stubEnv('HIVEWARD_USER_DATA_PATH', '')
  vi.stubEnv('HIVEWARD_USER_DATA_PATH', '/tmp/hiveward-parent')
  expect(getDefaultUserDataPath()).toBe('/tmp/hiveward-parent')
})
