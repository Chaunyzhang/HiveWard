import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

test('真实 preload 可执行，只暴露 hivewardDesktop 受限能力', async () => {
  const exposed = new Map()
  const ipcRenderer = { invoke: () => {}, send: () => {}, on: () => {}, removeListener: () => {} }
  runInNewContext(
    await readFile(new URL('../../hiveward/desktop/preload.cjs', import.meta.url), 'utf8'),
    {
      require: () => ({
        contextBridge: { exposeInMainWorld: (key, api) => exposed.set(key, api) },
        ipcRenderer
      }),
      process: { platform: 'darwin' },
      window: { addEventListener: () => {} }
    }
  )
  assert.deepEqual([...exposed.keys()], ['hivewardDesktop'])
  assert.equal('require' in exposed.get('hivewardDesktop'), false)
})
