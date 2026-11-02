import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientFrame, terminalDecoder } from './terminal-stream-codec.mjs'

test('client frames preserve raw input and reject invalid dimensions/types', () => {
  const data = '\u001b[200~中文😀\r\u0003\u001b[201~'
  assert.deepEqual(clientFrame(JSON.stringify({ type: 'input', data })), { type: 'input', data })
  assert.deepEqual(clientFrame('{"type":"resize","cols":120,"rows":40}'), {
    type: 'resize',
    cols: 120,
    rows: 40
  })
  for (const raw of [
    'null',
    '{}',
    '{',
    '{"type":"input","data":4}',
    '{"type":"resize","cols":0,"rows":40}',
    '{"type":"resize","cols":1.5,"rows":40}'
  ]) {
    assert.throws(() => clientFrame(raw))
  }
})

test('UTF-8 split at every byte preserves snapshot and live output', () => {
  const frames = [],
    decode = terminalDecoder((frame) => frames.push(frame))
  const text = '\u001b[31m你好😀\u001b[0m\r\n'
  decode({ type: 'snapshot-start', payload: Buffer.from('{"cols":120,"rows":40}') })
  for (const byte of Buffer.from(text)) {
    decode({ type: 'snapshot-chunk', payload: Buffer.from([byte]) })
  }
  decode({ type: 'snapshot-end' })
  for (const byte of Buffer.from(text)) {
    decode({ type: 'output', payload: Buffer.from([byte]) })
  }
  decode({ type: 'exit' })
  assert.deepEqual(frames[0], { type: 'snapshot', data: text, cols: 120, rows: 40 })
  assert.equal(
    frames
      .filter((f) => f.type === 'data')
      .map((f) => f.data)
      .join(''),
    text
  )
  assert.deepEqual(frames.at(-1), { type: 'exit' })
})

test('malformed snapshot framing fails rather than publishing a partial screen', () => {
  const decode = terminalDecoder(() => assert.fail('unexpected frame'))
  assert.throws(() => decode({ type: 'snapshot-chunk', payload: Buffer.from('x') }))
  assert.throws(() => decode({ type: 'snapshot-end' }))
})
