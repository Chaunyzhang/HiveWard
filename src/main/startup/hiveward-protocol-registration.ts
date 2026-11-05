import { hivewardProduct } from '../../shared/hiveward-policy'
import type { App } from 'electron'

/**
 * Registers HiveWard links with Windows, which NSIS installs leave unregistered; macOS reads it from
 * Info.plist and Linux packages from the desktop entry. Only packaged desktop launches register,
 * so dev, test and serve runs never take over the machine's handler.
 */
export function registerHiveWardProtocolClient(
  app: Pick<App, 'isPackaged' | 'isDefaultProtocolClient' | 'setAsDefaultProtocolClient'>,
  options: { platform: NodeJS.Platform; desktopLaunch: boolean }
): boolean {
  if (options.platform !== 'win32' || !app.isPackaged || !options.desktopLaunch) {
    return false
  }
  let changed = false
  for (const scheme of [hivewardProduct.scheme]) {
    if (app.isDefaultProtocolClient(scheme)) {
      continue
    }
    try {
      changed = app.setAsDefaultProtocolClient(scheme) || changed
    } catch {
      console.warn('[protocol] Failed to register HiveWard links:', scheme)
    }
  }
  return changed
}

export function normalizeHiveWardProtocolUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'hiveward:') {
      return null
    }
    url.protocol = 'hiveward:'
    return url.href
  } catch {
    return null
  }
}
