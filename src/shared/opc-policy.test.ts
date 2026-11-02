import { describe, expect, it } from 'vitest'
import { isBlockedVendorUrl, opcProduct } from './opc-policy'
import { getRuntimeMetadataPath } from './runtime-bootstrap'

describe('OPC isolation policy', () => {
  it('blocks vendor services, subdomains and updater feeds', () => {
    for (const url of [
      'https://login.onorca.dev/v1/desktop/auth/session',
      'wss://relay.onorca.dev',
      'https://us.i.posthog.com/batch',
      'https://ONORCA.DEV./plugins/stats.json',
      'https://api.github.com/repos/stablyai/orca/releases',
      'https://github.com/stablyai/orca/releases/latest/download'
    ]) {
      expect(isBlockedVendorUrl(url), url).toBe(true)
    }
  })
  it('preserves local RPC and independent provider access', () => {
    for (const url of [
      'http://127.0.0.1:17291',
      'https://api.anthropic.com',
      'https://github.com/example/project',
      'https://onorca.dev.example.com'
    ]) {
      expect(isBlockedVendorUrl(url), url).toBe(false)
    }
  })
  it('has independent metadata, profiles, protocol and home', () => {
    expect(getRuntimeMetadataPath('/profile')).toBe('/profile/opc-runtime.json')
    expect(opcProduct.dataDirectory).toBe('OPC-Engine')
    expect(opcProduct.devDataDirectory).not.toBe(opcProduct.dataDirectory)
    expect(opcProduct.homeDirectory).toBe('.opc-engine')
    expect(opcProduct.scheme).toBe('opc-engine')
    expect(opcProduct.globalCliRegistration).toBe(false)
  })
})
