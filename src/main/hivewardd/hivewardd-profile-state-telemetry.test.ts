import { describe, expect, it } from 'vitest'
import {
  emitHivewarddProfileStateAuthoritySelected,
  formatHivewarddProfileStateAuthoritySelected,
  type HivewarddProfileStateAuthoritySelection
} from './hivewardd-profile-state-telemetry'

const selection: HivewarddProfileStateAuthoritySelection = {
  backend: 'sqlite',
  classification: 'json-only',
  authority_mode: 'sqlite-established',
  runtime: 'hivewardd',
  migrated: true
}

describe('hivewardd profile-state telemetry', () => {
  it('strips unexpected runtime fields before writing the record', () => {
    const selectionWithRuntimeFields = Object.assign({}, selection, {
      database_path: '/private/profile-state.db'
    })
    const line = formatHivewarddProfileStateAuthoritySelected(selectionWithRuntimeFields)
    expect(line).not.toContain('database_path')
  })

  it('never lets a failing sink block startup', () => {
    expect(() =>
      emitHivewarddProfileStateAuthoritySelected(selection, () => {
        throw new Error('closed stderr')
      })
    ).not.toThrow()
  })
})
