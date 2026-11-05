import { assertVendorUrlAllowed } from '../../shared/hiveward-policy'

export function installHiveWardNetworkPolicy(): void {
  const fetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    assertVendorUrlAllowed(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    return fetch(input, init)
  }
}
