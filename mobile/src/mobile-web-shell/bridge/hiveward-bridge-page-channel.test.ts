import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHiveWardBridgePageTransport,
  readHiveWardBridgePageChannel,
  type HiveWardBridgePageChannel
} from './hiveward-bridge-page-channel'

function installChannel(channel: unknown): void {
  Object.defineProperty(globalThis, 'hivewardBridge', { value: channel, configurable: true })
}

function createChannel(): HiveWardBridgePageChannel {
  return { postMessage: vi.fn(), onmessage: null }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'hivewardBridge')
})

describe('the page channel the shell installs', () => {
  it('is absent in a browser, which is a page the bundle still has to open', () => {
    expect(readHiveWardBridgePageChannel()).toBeNull()
  })

  it('refuses a global of another shape rather than posting into it', () => {
    installChannel({ postMessage: 'not a function', onmessage: null })
    expect(readHiveWardBridgePageChannel()).toBeNull()
  })

  it('reads the installed object itself, so the page posts through the real sink', () => {
    const channel = createChannel()
    installChannel(channel)
    expect(readHiveWardBridgePageChannel()).toBe(channel)
  })
})

describe('the page channel as a client transport', () => {
  it('posts what the client sends', () => {
    const channel = createChannel()
    createHiveWardBridgePageTransport(channel).send('{"v":1}')
    expect(channel.postMessage).toHaveBeenCalledWith('{"v":1}')
  })

  it('hands the client the frame off the event, and gives the slot back', () => {
    const channel = createChannel()
    const handler = vi.fn()
    const release = createHiveWardBridgePageTransport(channel).onMessage(handler)
    channel.onmessage?.({ data: '{"v":1,"type":"init"}' })
    expect(handler).toHaveBeenCalledWith('{"v":1,"type":"init"}')
    release()
    expect(channel.onmessage).toBeNull()
  })
})
