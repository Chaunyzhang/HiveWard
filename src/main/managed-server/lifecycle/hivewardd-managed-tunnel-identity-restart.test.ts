import { pairedRuntimeConnectionFromOffer } from '../../../shared/paired-runtime-connection'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from '../../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  markEnvironmentUsed
} from '../../../shared/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { HiveWardRuntimeService } from '../../runtime/hiveward-runtime'
import { HiveWardRuntimeRpcServer } from '../../runtime/runtime-rpc'
import { verifyRuntimePairingIdentity } from '../../runtime/runtime-environment-identity-verification'
import { verifyManagedHivewarddTunnelIdentity } from './hivewardd-managed-tunnel-identity'
import { getPreferredPairingOffer } from '../../../shared/runtime-environments'
import {
  addWslHostEnvironment,
  refreshWslHostPairing
} from '../../../shared/runtime-environment-wsl-host-store'
import { buildServePairingReadiness } from '../../server/serve-pairing-readiness'
import { WslHivewarddConnectionManager } from '../../wsl/wsl-hivewardd-connection'

vi.mock('../../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const servers: HiveWardRuntimeRpcServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

async function startHivewardd(userDataPath: string): Promise<HiveWardRuntimeRpcServer> {
  const server = new HiveWardRuntimeRpcServer({
    runtime: new HiveWardRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  servers.push(server)
  return server
}

function pairingOffer(server: HiveWardRuntimeRpcServer): PairingOffer {
  const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'Desktop A' })
  if (!offer.available) {
    throw new Error('pairing unavailable')
  }
  return parsePairingCode(offer.pairingUrl)!
}

function managedEnvironment(pairing: PairingOffer, runtimeId: string): KnownRuntimeEnvironment {
  return {
    id: 'env-1',
    name: 'Box server',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId,
    preferredEndpointId: 'ws',
    endpoints: [
      {
        id: 'ws',
        kind: 'websocket',
        label: 'Box',
        endpoint: pairing.endpoint,
        deviceToken: pairing.deviceToken,
        publicKeyB64: pairing.publicKeyB64
      }
    ],
    connectionDependency: 'ssh-tunnel',
    hivewarddDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: 1,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

function reachedThrough(pairing: PairingOffer, server: HiveWardRuntimeRpcServer): PairingOffer {
  const port = new URL(pairingOffer(server).endpoint).port
  const endpoint = new URL(pairing.endpoint)
  endpoint.port = port
  return { ...pairing, endpoint: endpoint.toString() }
}

describe('reopening a managed tunnel after hivewardd restarted elsewhere', () => {
  it('keeps the WSL caller across host and desktop restarts, until explicit re-pairing', async () => {
    const hostProfile = mkdtempSync(join(tmpdir(), 'hivewardd-wsl-host-'))
    const desktopProfile = mkdtempSync(join(tmpdir(), 'hivewardd-wsl-client-'))
    let server = await startHivewardd(hostProfile)
    const connect = async () => {
      const manager = new WslHivewarddConnectionManager({
        getPairingOffer: () => {
          const [saved] = listEnvironments(desktopProfile)
          return saved ? getPreferredPairingOffer(saved) : null
        },
        deployAndLaunch: async () => ({
          outcome: 'ready',
          distro: 'Ubuntu',
          distroId: null,
          fullVersion: '1',
          pid: null,
          holder: 'adopted',
          port: Number(new URL(server.getWebSocketEndpoint()!).port),
          readiness: {
            runtimeId: server['runtime'].getRuntimeId(),
            managedWslCliReconciliation: 'settled',
            ...(await buildServePairingReadiness({ pairingAddress: '127.0.0.1' }, server))
          }
        }),
        listen: async (_transport, { remotePort }) => ({
          entry: {
            id: 'bridge',
            connectionId: 'wsl:ubuntu',
            localPort: remotePort,
            remoteHost: '127.0.0.1',
            remotePort
          },
          close: async () => {},
          dispose: () => {}
        })
      })
      const dispatch = vi.spyOn(server['dispatcher'], 'dispatchStreaming')
      try {
        const connection = await manager.ensure('Ubuntu')
        return {
          connection,
          caller: dispatch.mock.calls.at(-1)?.[2]?.authenticatedCallerFingerprint
        }
      } finally {
        dispatch.mockRestore()
        await manager.dispose()
      }
    }
    const first = await connect()
    expect(first.caller).toBeTruthy()
    addWslHostEnvironment(desktopProfile, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu',
      pairingCode: first.connection.pairingOffer,
      record: {
        kind: 'wsl',
        distro: 'Ubuntu',
        localPort: first.connection.localPort,
        remotePort: first.connection.remotePort
      }
    })
    await server.stop()
    server = await startHivewardd(hostProfile)
    const restarted = await connect()
    expect(restarted.caller).toBe(first.caller)
    const paired = parsePairingCode(first.connection.pairingOffer)!
    server.getDeviceRegistry()!.removeDevice(paired.pairedDeviceId!)
    await expect(connect()).rejects.toThrow('hivewardd_pairing_rejected')
    refreshWslHostPairing(desktopProfile, 'wsl:ubuntu', {
      pairingCode: encodePairingOffer(pairingOffer(server)),
      localPort: restarted.connection.localPort,
      remotePort: restarted.connection.remotePort
    })
    const rePaired = await connect()
    expect(rePaired.caller).toBeTruthy()
    expect(rePaired.caller).not.toBe(first.caller)
  })

  it('accepts the same host under a new runtime id, and its status recovers', async () => {
    const hostProfile = mkdtempSync(join(tmpdir(), 'hivewardd-host-'))
    const first = await startHivewardd(hostProfile)
    const paired = pairingOffer(first)
    const recorded = (
      await verifyRuntimePairingIdentity(pairedRuntimeConnectionFromOffer(paired), {
        runtimeId: null
      })
    ).verifiedRuntimeId
    await first.stop()

    const restarted = await startHivewardd(hostProfile)
    const pairing = reachedThrough(paired, restarted)

    await expect(
      verifyManagedHivewarddTunnelIdentity(managedEnvironment(pairing, recorded))
    ).resolves.toEqual({ verdict: 'verified' })
    // Authenticated status records the restarted process's new runtime ID.
    const status = await verifyRuntimePairingIdentity(pairedRuntimeConnectionFromOffer(pairing), {
      runtimeId: null
    })
    expect(status.verifiedRuntimeId).not.toBe(recorded)
    const desktopProfile = mkdtempSync(join(tmpdir(), 'desktop-a-'))
    const saved = addEnvironmentFromPairingCode(desktopProfile, {
      name: 'Box server',
      pairingCode: encodePairingOffer(pairing)
    })
    markEnvironmentUsed(desktopProfile, saved.id, { runtimeId: recorded })
    markEnvironmentUsed(desktopProfile, saved.id, {
      runtimeId: status.verifiedRuntimeId,
      pairingDeviceToken: pairing.deviceToken
    })
    expect(listEnvironments(desktopProfile)[0]?.runtimeId).toBe(status.verifiedRuntimeId)
  })

  it('still refuses a different host that answers on the tunnel', async () => {
    const paired = pairingOffer(await startHivewardd(mkdtempSync(join(tmpdir(), 'hivewardd-host-'))))
    const other = await startHivewardd(mkdtempSync(join(tmpdir(), 'hivewardd-other-')))

    await expect(
      verifyManagedHivewarddTunnelIdentity(
        managedEnvironment(reachedThrough(paired, other), 'runtime-recorded')
      )
    ).resolves.toMatchObject({ verdict: 'foreign' })
  })
})
