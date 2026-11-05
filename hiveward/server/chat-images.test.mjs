import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatImage, readChat } from './transcripts.mjs'

const png = Buffer.from('89504e470d0a1a0a', 'hex')
const image = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') }
}
const line = (rec) => `${JSON.stringify(rec)}\n`

test('贴的图进同一个气泡，工具截图挂在工具上，按 id 读回原图', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hiveward-chat-img-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(
    file,
    line({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: [image, { type: 'text', text: '看这张' }] }
    }) +
      line({
        type: 'user',
        uuid: 'u1m',
        message: { role: 'user', content: [{ type: 'text', text: '[Image: source: /tmp/a.png]' }] }
      })
  )
  let items = readChat('claude', file)
  assert.equal(items.length, 1)
  assert.equal(items[0].text, '看这张')
  assert.equal(items[0].images.length, 1)
  assert.deepEqual(chatImage(items[0].images[0].id), { raw: png, type: 'image/png' })

  // 增量读到的后一行（工具返回截图）也能按字节位置读回来
  appendFileSync(
    file,
    line({
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Screenshot', input: {} }]
      }
    }) +
      line({
        type: 'user',
        uuid: 'r1',
        toolUseResult: {},
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: '好了' }, image]
            }
          ]
        }
      })
  )
  items = readChat('claude', file)
  const tool = items.find((i) => i.kind === 'tool')
  assert.equal(tool.images.length, 1)
  assert.equal(chatImage(tool.images[0].id).raw.equals(png), true)
})

test('没登记过的 id 是 404', () => {
  assert.throws(
    () => chatImage('0'.repeat(32)),
    (e) => e.status === 404
  )
})
