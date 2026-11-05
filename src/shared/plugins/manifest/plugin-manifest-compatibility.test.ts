import { describe, expect, it } from 'vitest'
import { pluginManifestCompatibilityError } from './plugin-manifest-compatibility'

describe('pluginManifestCompatibilityError', () => {
  it('names the HiveWard a newer plugin needs', () => {
    expect(
      pluginManifestCompatibilityError({ engines: { hiveward: '>=9.1.0' }, novel: true }, '1.4.0')
    ).toBe('requires HiveWard >=9.1.0 (this is 1.4.0)')
  })

  it('names a manifest format this build cannot read', () => {
    expect(pluginManifestCompatibilityError({ manifestVersion: 3 }, '1.4.0')).toBe(
      'requires HiveWard support for manifest format 3 (this is 1.4.0)'
    )
  })

  it('reads the leading floor of a range grammar it does not know', () => {
    expect(pluginManifestCompatibilityError({ engines: { hiveward: '>=9.0.0 <10' } }, '1.4.0')).toBe(
      'requires HiveWard >=9.0.0 <10 (this is 1.4.0)'
    )
  })

  it('leaves ordinary mistakes to the schema', () => {
    expect(pluginManifestCompatibilityError({ engines: { hiveward: '>=1.0.0' } }, '1.4.0')).toBeNull()
    expect(pluginManifestCompatibilityError({ engines: { hiveward: '^9.0.0' } }, '1.4.0')).toBeNull()
    expect(pluginManifestCompatibilityError({ manifestVersion: 2 }, '1.4.0')).toBeNull()
    expect(pluginManifestCompatibilityError('not a manifest', '1.4.0')).toBeNull()
  })
})
