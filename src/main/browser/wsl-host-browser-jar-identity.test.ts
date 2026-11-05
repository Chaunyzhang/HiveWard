/**
 * R45: which in-app browser jar a WSL host's pages get, pinned by what can change about the host.
 * The jar follows the environment (named by the distro) and hivewardd's key; the distro's registry id
 * is deliberately not part of it (#29610).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { defaultWslHivewarddEnvironmentId } from '../wsl/wsl-hivewardd-deploy'

const bindings = vi.hoisted(() => ({ filePath: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('./browser-route-partition-binding-runtime', async () => {
  const { BrowserRoutePartitionBindingStore } =
    await import('./browser-route-partition-binding-store')
  return {
    currentBrowserRoutePartitionBindingStore: () =>
      new BrowserRoutePartitionBindingStore({ filePath: bindings.filePath })
  }
})
vi.mock('./browser-route-partition-storage-dependencies', () => ({
  releaseEvictedBrowserRoutePartitionStorage: vi.fn(async () => {})
}))

import {
  bindWslHostBrowserRoutePartition,
  wslHostBrowserRouteStorage
} from './wsl-host-browser-route-partition'

const HIVEWARD_PROFILE = 'profile-a'

function wslHost(
  distro: string,
  hostKey: string,
  pairing = { revision: 1, device: 'device-a' }
): KnownRuntimeEnvironment {
  return {
    id: defaultWslHivewarddEnvironmentId(distro),
    name: distro,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    pairingRevision: pairing.revision,
    pairedDeviceId: pairing.device,
    hivewarddDeployment: { kind: 'wsl', distro, localPort: 9999, remotePort: 7777 },
    preferredEndpointId: 'endpoint-a',
    endpoints: [
      {
        id: 'endpoint-a',
        kind: 'websocket',
        label: distro,
        endpoint: 'ws://127.0.0.1:9999',
        deviceToken: `token-${pairing.device}`,
        publicKeyB64: hostKey
      }
    ]
  }
}

function jar(environment: KnownRuntimeEnvironment): string {
  const result = wslHostBrowserRouteStorage(HIVEWARD_PROFILE, environment)
  if (result.kind !== 'stable') {
    throw new Error(`expected a stable partition, got ${result.reason}`)
  }
  return bindWslHostBrowserRoutePartition(result.storage, 'default')
}

let directory: string

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'wsl-host-jar-')))
  bindings.filePath = join(directory, 'bindings.json')
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('WSL host browser jar identity', () => {
  it('starts a new jar when the distro runs a newly deployed hivewardd (a new key)', () => {
    const before = jar(wslHost('Ubuntu', 'hivewardd-key-a'))

    expect(jar(wslHost('Ubuntu', 'hivewardd-key-b'))).not.toBe(before)
    // The old jar is still the old key's; nothing of it moved to the new one.
    expect(jar(wslHost('Ubuntu', 'hivewardd-key-a'))).toBe(before)
  })

  it('starts a new jar for a renamed distro, even one that kept its hivewardd key', () => {
    const before = jar(wslHost('Ubuntu', 'hivewardd-key-a'))

    expect(jar(wslHost('Ubuntu-work', 'hivewardd-key-a'))).not.toBe(before)
  })

  // A golden image with a baked-in hivewardd key, imported twice on one desktop.
  it('keeps two distros that carry the same hivewardd key in separate jars', () => {
    expect(jar(wslHost('Ubuntu', 'baked-key'))).not.toBe(jar(wslHost('Ubuntu-2', 'baked-key')))
  })

  // Accepted (R45, Low): the same name and key is the same host to this desktop.
  it('keeps the jar for a distro re-imported under its old name with its old key', () => {
    const before = jar(wslHost('Ubuntu', 'hivewardd-key-a'))

    expect(jar(wslHost('Ubuntu', 'hivewardd-key-a', { revision: 7, device: 'device-b' }))).toBe(before)
  })
})
