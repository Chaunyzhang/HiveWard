import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'

describe('getDefaultSettings', () => {
  it('uses platform-consistent separators for the default workspace directory', () => {
    expect(getDefaultSettings('/Users/alice').workspaceDir).toBe('/Users/alice/hiveward/workspaces')
    expect(getDefaultSettings('C:\\Users\\alice').workspaceDir).toBe(
      'C:\\Users\\alice\\hiveward\\workspaces'
    )
  })
})
