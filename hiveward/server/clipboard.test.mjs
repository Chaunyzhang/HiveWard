import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClipboardNetwork, digest, waitFor } from './clipboard-test-fixture.mjs'

const settings = (enabled = true, maxFileBytes = 1024 * 1024) => ({ enabled, maxFileBytes })
const enable = async (instance, limit) => {
  const response = await instance.local('/api/clipboard/settings', settings(true, limit))
  assert.equal(response.status, 200)
}

test('clipboard is opt-in and settings are local-only', async () => {
  const network = await createClipboardNetwork()
  try {
    const a = await network.add('A')
    await network.add('B')
    const initial = await a.local('/api/clipboard')
    assert.equal(initial.status, 200)
    assert.equal(initial.data.settings.enabled, false)
    a.adapter.copy({ kind: 'text', text: 'private test payload' })
    assert.equal(a.adapter.reads(), 0)
    assert.equal(a.adapter.watching(), false)
    const remote = await network.send('A', 'B', '/api/clipboard/settings', {
      method: 'POST',
      body: settings()
    })
    const forwarded = await a.local('/api/m/B/api/clipboard/settings', settings())
    assert.equal(remote.status, 403)
    assert.equal(forwarded.status, 403)
    await enable(a)
    assert.equal(a.adapter.watching(), true)
    console.log(
      'ACCEPT clipboard opt-in',
      JSON.stringify({ remoteSettings: 403, forwardedSettings: 403 })
    )
  } finally {
    await network.close()
  }
})

test('two instances sync rich text without content metadata or echo', async () => {
  const network = await createClipboardNetwork()
  try {
    const a = await network.add('A')
    const b = await network.add('B')
    await enable(a)
    await enable(b)
    const payload = {
      kind: 'text',
      text: 'unique rich text payload',
      html: '<b>unique rich text payload</b>',
      rtf: '{\\rtf1 unique rich text payload}'
    }
    a.adapter.copy(payload)
    await waitFor(() => b.adapter.writes.length === 1)
    const received = b.adapter.value()
    assert.ok(digest(JSON.stringify(received)) === digest(JSON.stringify(payload)))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(a.adapter.writes.length, 0)
    const status = await b.local('/api/clipboard')
    const persisted = await readFile(join(b.directory, 'clipboard.json'), 'utf8')
    assert.ok(!JSON.stringify(status).includes(payload.text))
    assert.ok(!persisted.includes(payload.text))
    assert.ok(!persisted.includes(payload.html))
    console.log(
      'ACCEPT text',
      JSON.stringify({
        bytes: Buffer.byteLength(payload.text),
        sha256: digest(payload.text),
        echoWrites: a.adapter.writes.length
      })
    )
  } finally {
    await network.close()
  }
})

test('two instances sync PNG using lengths and hashes only', async () => {
  const network = await createClipboardNetwork()
  try {
    const a = await network.add('A')
    const b = await network.add('B')
    await enable(a)
    await enable(b)
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from('synthetic png test bytes')
    ])
    a.adapter.copy({ kind: 'image', png })
    await waitFor(() => b.adapter.writes.length === 1)
    assert.ok(digest(b.adapter.value().png) === digest(png))
    const status = await b.local('/api/clipboard')
    assert.ok(!JSON.stringify(status).includes(png.toString('base64')))
    console.log('ACCEPT image', JSON.stringify({ bytes: png.length, sha256: digest(png) }))
  } finally {
    await network.close()
  }
})

test('excluded clipboard formats record skipped and never reach a peer', async () => {
  const network = await createClipboardNetwork()
  try {
    const a = await network.add('A')
    const b = await network.add('B')
    await enable(a)
    await enable(b)
    a.adapter.copy({ kind: 'text', skipped: 'excluded_format' })
    await waitFor(() => a.service && a.adapter.reads() === 1)
    await waitFor(
      async () => (await a.local('/api/clipboard')).data.recent[0]?.skipped === 'excluded_format'
    )
    assert.equal(b.adapter.writes.length, 0)
    const recent = (await a.local('/api/clipboard')).data.recent[0]
    assert.equal(recent.skipped, 'excluded_format')
    assert.ok(!('text' in recent))
    console.log(
      'ACCEPT excluded formats',
      JSON.stringify({ skipped: recent.skipped, peerWrites: 0 })
    )
  } finally {
    await network.close()
  }
})

test('later arrivals win, duplicate events and applied writes do not echo', async () => {
  const network = await createClipboardNetwork()
  try {
    const a = await network.add('A')
    const b = await network.add('B', { writeDelay: 40 })
    const c = await network.add('C')
    await Promise.all([enable(a), enable(b), enable(c)])
    const first = { kind: 'text', text: 'first concurrent payload' }
    const second = { kind: 'text', text: 'second concurrent payload' }
    const firstId = randomUUID()
    const send = (from, eventId, text) =>
      network.send(from, 'B', '/api/clipboard/push', {
        method: 'POST',
        body: { eventId, origin: from, kind: 'text', text }
      })
    const earlier = send('A', firstId, first.text)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const later = send('C', randomUUID(), second.text)
    assert.equal((await earlier).status, 200)
    assert.equal((await later).status, 200)
    assert.equal((await send('A', firstId, first.text)).status, 200)
    await waitFor(() => b.adapter.writes.length === 2)
    assert.ok(digest(b.adapter.value().text) === digest(second.text))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(a.adapter.writes.length, 0)
    assert.equal(c.adapter.writes.length, 0)
    console.log(
      'ACCEPT concurrency',
      JSON.stringify({
        writes: b.adapter.writes.length,
        finalSha256: digest(b.adapter.value().text),
        duplicateApplied: false
      })
    )
  } finally {
    await network.close()
  }
})
