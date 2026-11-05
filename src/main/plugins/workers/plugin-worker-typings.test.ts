import { describe, expect, it, vi } from 'vitest'
import {
  exportedTypeShape,
  runtimeShape
} from '../../../shared/plugins/authoring/plugin-author-typings.test-fixture'
import { createPluginWorkerRuntime, type PluginWorkerHiveWardApi } from './plugin-host-runtime'

async function activatedHiveWard(): Promise<PluginWorkerHiveWardApi> {
  const captured: { hiveward?: PluginWorkerHiveWardApi } = {}
  const runtime = createPluginWorkerRuntime({
    send: vi.fn(),
    exit: vi.fn(),
    importModule: async () => ({ default: (api: PluginWorkerHiveWardApi) => (captured.hiveward = api) })
  })
  await runtime.handleMessage({
    hiveward: 1,
    kind: 'evt',
    event: 'init',
    payload: {
      pluginId: 'samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'main.mjs',
      grantedCapabilities: []
    }
  })
  if (!captured.hiveward) {
    throw new Error('activate was not called')
  }
  return captured.hiveward
}

describe('hiveward-worker.d.ts matches the activate(hiveward) object', () => {
  it('declares exactly the members a worker gets', async () => {
    const typings = exportedTypeShape('hiveward/worker', 'HiveWardWorkerApi')
    expect(typings.optional).toEqual([])
    expect(runtimeShape(await activatedHiveWard())).toEqual(typings.shape)
  })
})
