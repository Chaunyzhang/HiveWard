import { describe, expect, it } from 'vitest'
import {
  bindHostIsNetworkExposed,
  HIVEWARDD_LOOPBACK_BIND_HOST,
  HivewarddBindAddressError,
  resolveHivewarddBindHost
} from './hivewardd-bind-address'

describe('resolveHivewarddBindHost', () => {
  it('defaults to loopback when the operator asked for nothing', () => {
    expect(resolveHivewarddBindHost()).toBe(HIVEWARDD_LOOPBACK_BIND_HOST)
    expect(HIVEWARDD_LOOPBACK_BIND_HOST).toBe('127.0.0.1')
  })

  it('accepts literal IPv4 and IPv6 addresses, including explicit wide binds', () => {
    expect(resolveHivewarddBindHost('0.0.0.0')).toBe('0.0.0.0')
    expect(resolveHivewarddBindHost('10.1.2.3')).toBe('10.1.2.3')
    expect(resolveHivewarddBindHost('::1')).toBe('::1')
    expect(resolveHivewarddBindHost('localhost')).toBe('127.0.0.1')
    expect(resolveHivewarddBindHost(' 127.0.0.1 ')).toBe('127.0.0.1')
  })

  it('refuses hostnames, because DNS would decide which interface got bound', () => {
    expect(() => resolveHivewarddBindHost('internal.example')).toThrow(HivewarddBindAddressError)
    expect(() => resolveHivewarddBindHost('')).toThrow(HivewarddBindAddressError)
    expect(() => resolveHivewarddBindHost('0.0.0.0:80')).toThrow(HivewarddBindAddressError)
  })
})

describe('bindHostIsNetworkExposed', () => {
  it('separates local-only addresses from network-reachable ones', () => {
    expect(bindHostIsNetworkExposed('127.0.0.1')).toBe(false)
    expect(bindHostIsNetworkExposed('127.5.5.5')).toBe(false)
    expect(bindHostIsNetworkExposed('::1')).toBe(false)
    expect(bindHostIsNetworkExposed('0.0.0.0')).toBe(true)
    expect(bindHostIsNetworkExposed('::')).toBe(true)
    expect(bindHostIsNetworkExposed('10.1.2.3')).toBe(true)
  })
})
