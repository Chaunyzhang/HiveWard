import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hivewardEnvironment } from './hiveward-environment.mjs'

test('环境变量直接读写 HIVEWARD_*', () => {
  const previous = hivewardEnvironment.HIVEWARD_BRIDGE
  try {
    hivewardEnvironment.HIVEWARD_BRIDGE = 'http://127.0.0.1:12345'
    assert.equal(process.env.HIVEWARD_BRIDGE, 'http://127.0.0.1:12345')
  } finally {
    if (previous === undefined) {
      delete hivewardEnvironment.HIVEWARD_BRIDGE
    } else {
      hivewardEnvironment.HIVEWARD_BRIDGE = previous
    }
  }
})
