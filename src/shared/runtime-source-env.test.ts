import { describe, expect, it } from 'vitest'
import { readRuntimeSourceStamp } from './runtime-source-env'

describe('runtime source env', () => {
  it('treats a partial or oversized stamp as no stamp', () => {
    expect(readRuntimeSourceStamp({ HIVEWARD_RUNTIME_SOURCE_ID: 'only-id' })).toBeNull()
    expect(
      readRuntimeSourceStamp({
        HIVEWARD_RUNTIME_SOURCE_ID: 'x'.repeat(4_097),
        HIVEWARD_RUNTIME_SOURCE_INCARNATION: 'runtime'
      })
    ).toBeNull()
  })
})
