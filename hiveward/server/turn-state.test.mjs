import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTurnState } from './transcripts.mjs'

test('intermediate Codex replies cannot finish a turn; explicit completion can', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hiveward-turn-')),
    file = join(dir, 'codex.jsonl')
  const append = (payload) =>
    appendFileSync(file, `${JSON.stringify({ type: 'event_msg', payload })}\n`)
  try {
    append({ type: 'task_started' })
    append({
      type: 'item_completed',
      item: { type: 'AgentMessage', id: 'progress', content: 'I will do it.' }
    })
    assert.equal(readTurnState('codex', file), 'working')
    append({ type: 'task_complete' })
    assert.equal(readTurnState('codex', file), 'completed')
    append({ type: 'task_started' })
    assert.equal(readTurnState('codex', file), 'working')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
