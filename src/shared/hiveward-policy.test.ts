import { describe, expect, it } from 'vitest'
import { isBlockedVendorUrl, hivewardProduct } from './hiveward-policy'
import { getRuntimeMetadataPath } from './runtime-bootstrap'

describe('HiveWard isolation policy', () => {
  it('blocks vendor services, subdomains and updater feeds', () => {
    for (const url of [
      'https://login.onhiveward.dev/v1/desktop/auth/session',
      'wss://relay.onhiveward.dev',
      'https://us.i.posthog.com/batch',
      'https://ONHIVEWARD.DEV./plugins/stats.json',
      'https://api.github.com/repos/stablyai/example/releases',
      'https://github.com/stablyai/example/releases/latest/download'
    ]) {
      expect(isBlockedVendorUrl(url), url).toBe(true)
    }
  })
  it('preserves local RPC and independent provider access', () => {
    for (const url of [
      'http://127.0.0.1:17291',
      'https://api.anthropic.com',
      'https://github.com/example/project',
      'https://onhiveward.dev.example.com'
    ]) {
      expect(isBlockedVendorUrl(url), url).toBe(false)
    }
  })
  it('has independent metadata, profiles, protocol and home', () => {
    expect(getRuntimeMetadataPath('/profile')).toBe('/profile/hiveward-runtime.json')
    expect(hivewardProduct.dataDirectory).toBe('HiveWard')
    expect(hivewardProduct.devDataDirectory).not.toBe(hivewardProduct.dataDirectory)
    expect(hivewardProduct.homeDirectory).toBe('.hiveward')
    expect(hivewardProduct.scheme).toBe('hiveward')
    expect(hivewardProduct.globalCliRegistration).toBe(false)
  })
})
