import product from './hiveward-product.json'

export { product as hivewardProduct }
export const vendorServicesEnabled: boolean = product.vendorServices

export function isBlockedVendorUrl(value: string): boolean {
  if (vendorServicesEnabled) {
    return false
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    ['onhiveward.dev', 'hiveward.dev', 'stably.ai', 'stablyai.com', 'posthog.com'].some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    )
  ) {
    return true
  }
  return (
    ['github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(host) &&
    /^\/(?:repos\/)?stablyai\//i.test(url.pathname)
  )
}

export function assertVendorUrlAllowed(url: string): void {
  if (isBlockedVendorUrl(url)) {
    throw new Error('Stably services are disabled in HiveWard.')
  }
}
