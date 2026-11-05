import { expect, it } from 'vitest'
import { PAIRING_METHODS } from './pairing'

it('供应商中继配对方法从 RPC 注册中移除', () => {
  expect(PAIRING_METHODS.map((method) => method.name)).not.toContain('pairing.provisionRelay')
  expect(PAIRING_METHODS.map((method) => method.name)).not.toContain('pairing.getEndpoints')
})
