import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { HiveWardRuntimeService } from './hiveward-runtime'
import { HiveWardRuntimeRpcServer } from './runtime-rpc'
import { authenticateMobileWsSession } from './runtime-rpc-mobile-ws-test-harness'

vi.mock('../../shared/layout-owner-switch', () => ({ HIVEWARD_LAYOUT_OWNER_IS_MAIN: true }))

/** A runtime that answers the auth path and records the placement pass. */
function runtimeRecordingPlacement() {
  const placeUnshownLiveTerminals = vi.fn(async () => ({ placed: [], declined: [] }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake carries only the surface pairing, authentication and this pass read.
  const runtime = {
    configureNotificationDismissalStore: () => {},
    getRuntimeId: () => 'attach-runtime-test',
    getStartedAt: () => 1,
    machineNameReady: async () => undefined,
    getStatus: () => ({ graphStatus: 'unavailable' }),
    cleanupSubscriptionsForConnection: () => {},
    onClientDisconnected: () => {},
    placeUnshownLiveTerminals
  } as unknown as HiveWardRuntimeService
  return { runtime, placeUnshownLiveTerminals }
}

describe('a client attaching to a host, layout-owner build', () => {
  it('runs main’s pass that shows live terminals no pane shows', async () => {
    const { runtime, placeUnshownLiveTerminals } = runtimeRecordingPlacement()
    const server = new HiveWardRuntimeRpcServer({
      runtime,
      userDataPath: mkdtempSync(join(tmpdir(), 'hiveward-runtime-rpc-')),
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'p', scope: 'runtime' })
    if (!offer.available) {
      throw new Error('WebSocket pairing unavailable')
    }
    const session = await authenticateMobileWsSession(offer.pairingUrl)
    try {
      await vi.waitFor(() => expect(placeUnshownLiveTerminals).toHaveBeenCalledOnce())
    } finally {
      session.ws.close()
      await server.stop()
    }
  })

  it('still authenticates when that pass fails', async () => {
    const { runtime, placeUnshownLiveTerminals } = runtimeRecordingPlacement()
    placeUnshownLiveTerminals.mockRejectedValue(new Error('census unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = new HiveWardRuntimeRpcServer({
      runtime,
      userDataPath: mkdtempSync(join(tmpdir(), 'hiveward-runtime-rpc-')),
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'p', scope: 'runtime' })
    if (!offer.available) {
      throw new Error('WebSocket pairing unavailable')
    }
    const session = await authenticateMobileWsSession(offer.pairingUrl)
    session.ws.close()
    await server.stop()
    expect(placeUnshownLiveTerminals).toHaveBeenCalled()
  })
})
