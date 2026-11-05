import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { orchestrationFixture } from './tests/orchestration-module-fixture.mjs'

for (const status of ['pending', 'dispatched', 'blocked', 'completed', 'failed']) {
  test(`启动后不再按 hook 重判旧 ${status} 派单`, async (t) => {
    const f = await orchestrationFixture(t)
    const path = join(f.root, 'dispatches.json')
    const text = JSON.stringify([
      { id: 'dsp_old', status, prompt: '旧活', by: { kind: 'cli', id: 'leader' } }
    ])
    await writeFile(path, text)
    await f.api.observeDispatches(f.terminals)
    assert.equal(await readFile(path, 'utf8'), text)
    assert.equal(f.api.legacyDispatches()[0].status, status)
    assert.ok(!f.api.dispatches().some((d) => d.id === 'dsp_old'))
  })
}
