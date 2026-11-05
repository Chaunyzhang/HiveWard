import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { orchestrationFixture } from './tests/orchestration-module-fixture.mjs'

for (const agent of ['claude', 'codex', 'kimi', 'opencode']) {
  test(`${agent} 旧卡单不参与新编排 Task 的验收和释放`, async (t) => {
    const f = await orchestrationFixture(t)
    f.worker.projection.provider.id = agent
    const path = join(f.root, 'dispatches.json')
    const old = JSON.stringify([
      {
        id: 'dsp_stuck',
        handle: 'term_worker',
        prompt: '旧卡单',
        status: 'dispatched',
        by: { kind: 'owner', id: 'boss' }
      }
    ])
    await writeFile(path, old)
    f.report()
    await f.project()
    const review = await f.module('task-review.mjs')
    const result = await review.reviewTask(f.task.id, { verdict: 'accept' }, { kind: 'owner' })
    assert.equal(result.release.state, 'released')
    assert.equal(result.task.assignee.agent, agent)
    assert.equal(await readFile(path, 'utf8'), old)
  })
}
