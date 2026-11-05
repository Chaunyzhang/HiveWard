import { describe, expect, it } from 'vitest'
import { loadConnectorConfig } from './config.js'

const ENV = {
  HIVEWARD_CONNECTOR_PUBLIC_URL: 'https://connector.onhiveward.dev',
  HIVEWARD_CONNECTOR_AUTH_ISSUER: 'https://login.onhiveward.dev',
  HIVEWARD_CONNECTOR_JWKS_URL: 'https://login.onhiveward.dev/.well-known/jwks.json'
}

describe('connector config', () => {
  it('fills defaults around the required settings', () => {
    expect(loadConnectorConfig(ENV)).toEqual({
      mode: 'active',
      role: 'api',
      port: 8080,
      publicUrl: 'https://connector.onhiveward.dev',
      dataDir: './data/connector',
      databasePoolMax: 10,
      authIssuer: 'https://login.onhiveward.dev',
      jwksUrl: 'https://login.onhiveward.dev/.well-known/jwks.json',
      trustedProxyHops: 0
    })
  })

  it('treats a blank database URL as absent', () => {
    expect(loadConnectorConfig({ ...ENV, HIVEWARD_CONNECTOR_DATABASE_URL: ' ' }).databaseUrl).toBe(
      undefined
    )
  })

  it.each([
    ['a path on the public URL', { HIVEWARD_CONNECTOR_PUBLIC_URL: 'https://connector.onhiveward.dev/x' }],
    ['plain HTTP off loopback', { HIVEWARD_CONNECTOR_AUTH_ISSUER: 'http://login.onhiveward.dev' }],
    ['a missing key set URL', { HIVEWARD_CONNECTOR_JWKS_URL: undefined }],
    ['a plain HTTP key set URL', { HIVEWARD_CONNECTOR_JWKS_URL: 'http://login.onhiveward.dev/jwks' }],
    ['the gateway role without Discord', { HIVEWARD_CONNECTOR_ROLE: 'discord-gateway' }]
  ])('rejects %s', (_name, override) => {
    expect(() => loadConnectorConfig({ ...ENV, ...override })).toThrow()
  })

  it('allows plain HTTP on loopback for local development', () => {
    expect(
      loadConnectorConfig({ ...ENV, HIVEWARD_CONNECTOR_PUBLIC_URL: 'http://127.0.0.1:8080' }).publicUrl
    ).toBe('http://127.0.0.1:8080')
  })
})
