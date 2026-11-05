import { describe, expect, it } from 'vitest'
import {
  deriveBrowserRoutePartition,
  deriveBrowserRoutePartitionStorageScope,
  isBrowserRoutePartition
} from './browser-route-identity'

const identity = {
  hivewardProfileId: 'hiveward/profile:alpha',
  browserProfileId: 'browser/profile:default',
  authorityConnectionIdentity: 'paired/runtime:authority',
  executionHostIdentity: 'ssh/target:private.example'
}

const pinnedIdentity = {
  hivewardProfileId: 'hiveward/profile:alpha',
  browserProfileId: 'browser/profile:default',
  authorityConnectionIdentity: 'paired-runtime:authority-a',
  executionHostIdentity: '["hiveward-browser-execution-host-storage",1,"authority","env-a"]'
}

describe('browser route partition identity', () => {
  it('keeps delimiter-containing components structurally distinct', () => {
    const left = deriveBrowserRoutePartition({
      ...identity,
      hivewardProfileId: 'a',
      browserProfileId: 'b:c'
    })
    const right = deriveBrowserRoutePartition({
      ...identity,
      hivewardProfileId: 'a:b',
      browserProfileId: 'c'
    })

    expect(left).not.toEqual(right)
  })

  it('makes every identity component load-bearing', () => {
    const derived = [
      identity,
      { ...identity, hivewardProfileId: 'hiveward/profile:beta' },
      { ...identity, browserProfileId: 'browser/profile:work' },
      { ...identity, authorityConnectionIdentity: 'paired/runtime:other' },
      { ...identity, executionHostIdentity: 'ssh/target:other.example' }
    ].map((entry) => deriveBrowserRoutePartition(entry))

    expect(new Set(derived.map((entry) => entry.partition)).size).toBe(derived.length)
    expect(new Set(derived.map((entry) => entry.bindingFingerprint)).size).toBe(derived.length)
  })

  // Persisted names must remain stable to avoid silently relocating cookie jars.
  it('pins the derived partition and fingerprint against silent relocation', () => {
    expect(deriveBrowserRoutePartition(pinnedIdentity)).toEqual({
      partition:
        'persist:hiveward-browser-v1-c78aa618194773d066921db446f6a336320dfab1f0bd2188f1689b0437670522',
      bindingFingerprint: 'ea859558a2b58acd8f2682d2780075326bebc365f297f9121de21de23e5f2d8d'
    })
  })

  it('scopes partition ownership to one hiveward profile and one environment', () => {
    const scope = deriveBrowserRoutePartitionStorageScope({
      hivewardProfileId: 'hiveward/profile:alpha',
      environmentId: 'environment-a'
    })

    expect(scope).toBe('196f75c6b86948221059a66644045bffca3e6a2965629b0d3f2ed26cb3f64989')
    expect(
      deriveBrowserRoutePartitionStorageScope({
        hivewardProfileId: 'hiveward/profile:alpha',
        environmentId: 'environment-b'
      })
    ).not.toBe(scope)
    expect(
      deriveBrowserRoutePartitionStorageScope({
        hivewardProfileId: 'hiveward/profile:beta',
        environmentId: 'environment-a'
      })
    ).not.toBe(scope)
  })

  // These names are joined to the partition root for storage deletion.
  it('recognizes a route partition only as a whole name', () => {
    const valid = deriveBrowserRoutePartition(pinnedIdentity).partition

    expect(isBrowserRoutePartition(valid)).toBe(true)
    for (const value of [
      `../../${valid}`,
      `${valid}/../../escape`,
      `${valid}extra`,
      valid.replace('persist:', '')
    ]) {
      expect(isBrowserRoutePartition(value)).toBe(false)
    }
  })

  it('rejects empty and unbounded identity components', () => {
    expect(() => deriveBrowserRoutePartition({ ...identity, executionHostIdentity: '' })).toThrow(
      'browser_route_partition_identity_invalid'
    )
    expect(() =>
      deriveBrowserRoutePartition({ ...identity, authorityConnectionIdentity: 'x'.repeat(513) })
    ).toThrow('browser_route_partition_identity_invalid')
    expect(() =>
      deriveBrowserRoutePartition({ ...identity, authorityConnectionIdentity: 'é'.repeat(257) })
    ).toThrow('browser_route_partition_identity_invalid')
    expect(() =>
      deriveBrowserRoutePartition({ ...identity, authorityConnectionIdentity: 'é'.repeat(256) })
    ).not.toThrow()
  })
})
