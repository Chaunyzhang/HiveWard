import type { BridgeRpcClientOptions } from './bridge-rpc-client'

// Expose only postMessage/onmessage, the common surface of Android’s injected listener and Swift’s document-start installer; the page cannot address the wider WebView.
export type HiveWardBridgePageChannel = {
  postMessage: (json: string) => void
  onmessage: ((event: { data: string }) => void) | null
}

// No channel is valid in a browser or bridge-disabled WebView; let the caller substitute rather than throw.
export function readHiveWardBridgePageChannel(): HiveWardBridgePageChannel | null {
  const scope: typeof globalThis & { hivewardBridge?: HiveWardBridgePageChannel } = globalThis
  const channel = scope.hivewardBridge
  if (channel === undefined || typeof channel.postMessage !== 'function') {
    return null
  }
  return channel
}

// One onmessage slot requires one page client; a second would silently steal the first client’s frames.
export function createHiveWardBridgePageTransport(
  channel: HiveWardBridgePageChannel
): Pick<BridgeRpcClientOptions, 'send' | 'onMessage'> {
  return {
    send: (json) => {
      channel.postMessage(json)
    },
    onMessage: (handler) => {
      channel.onmessage = (event) => {
        handler(event.data)
      }
      return () => {
        channel.onmessage = null
      }
    }
  }
}
