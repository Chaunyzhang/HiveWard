import type { HandlerDetails, WebContents, WindowOpenHandlerResponse } from 'electron'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import {
  isBrowserTabPopupRequest,
  isNewBrowserTabPopupIntent,
  normalizeBrowserPopupUrl
} from '../browser/browser-popup-new-tab-intent'
import { SAFE_POPUP_WINDOW_OPTIONS } from '../browser/browser-manager-types'
import {
  allowNativeBrowserPopup,
  discardBrowserPopupContents,
  isNativeBrowserPopupRequest
} from '../browser/browser-popup-native-window'
import {
  openPopupWithOriginBar,
  type PopupChildWindowOptions,
  type PopupOriginBarWindow
} from '../browser/popup-origin-bar-window'

export type DesktopPopupHandlerOptions = {
  isActive: () => boolean
  openTab: (url: string, activate: boolean) => void
  prepareSession: (session: Electron.Session) => void
}

// 保留 Chromium 创建的 contents，才能维持 OAuth 的 opener、POST 和 referrer。
export function createDesktopPopupHandler(
  opener: WebContents,
  options: DesktopPopupHandlerOptions
): (details: HandlerDetails) => WindowOpenHandlerResponse {
  const followOpener = (popup: PopupOriginBarWindow): void => {
    const close = (): void => popup.close()
    opener.once('destroyed', close)
    popup.onClosed(() => {
      if (!opener.isDestroyed()) {
        opener.removeListener('destroyed', close)
      }
    })
  }

  const createChild = (childOptions: PopupChildWindowOptions, initialUrl: string): WebContents => {
    const popup = openPopupWithOriginBar(
      {
        ...childOptions,
        show: options.isActive() && childOptions.show !== false,
        webPreferences: { ...childOptions.webPreferences, session: opener.session }
      },
      initialUrl,
      (contents) => {
        if (contents.session !== opener.session) {
          return false
        }
        options.prepareSession(contents.session)
        contents.setWindowOpenHandler(createDesktopPopupHandler(contents, options))
        return true
      }
    )
    followOpener(popup)
    return popup.contentWebContents
  }

  return ({ url, frameName, disposition, postBody, features }) => {
    const externalUrl = normalizeExternalBrowserUrl(url)
    if (externalUrl && isNewBrowserTabPopupIntent({ url, frameName, disposition, postBody })) {
      options.openTab(externalUrl, options.isActive() && disposition !== 'background-tab')
      return { action: 'deny' }
    }
    // file:、data:、javascript: 等不能借原生弹窗进入本地或特权内容。
    if (normalizeBrowserPopupUrl(url) === null) {
      return { action: 'deny' }
    }

    const tabUrl =
      externalUrl && isBrowserTabPopupRequest({ frameName, disposition, postBody })
        ? externalUrl
        : null
    const openAsTabWithoutOpener = (childOptions: PopupChildWindowOptions): WebContents | null => {
      const contents = childOptions.nativeWindow?.webContents ?? childOptions.webContents
      if (!tabUrl || contents?.opener) {
        return null
      }
      options.openTab(tabUrl, options.isActive() && disposition !== 'background-tab')
      if (childOptions.webContents && !childOptions.nativeWindow) {
        discardBrowserPopupContents(childOptions.webContents)
        return childOptions.webContents
      }
      return openPopupWithOriginBar({ ...childOptions, show: false }, url, () => false)
        .contentWebContents
    }
    const create = (childOptions: PopupChildWindowOptions): WebContents =>
      openAsTabWithoutOpener(childOptions) ?? createChild(childOptions, url)
    const safeOptions: Electron.BrowserWindowConstructorOptions = {
      ...SAFE_POPUP_WINDOW_OPTIONS,
      show: options.isActive(),
      webPreferences: { ...SAFE_POPUP_WINDOW_OPTIONS.webPreferences, session: opener.session }
    }
    if (isNativeBrowserPopupRequest({ disposition, features, frameName })) {
      return allowNativeBrowserPopup({
        opener,
        options: safeOptions,
        background: disposition === 'background-tab' || !options.isActive(),
        canPresent: options.isActive,
        onCreated: create
      })
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: safeOptions,
      createWindow: (childOptions: PopupChildWindowOptions) => create(childOptions)
    }
  }
}
