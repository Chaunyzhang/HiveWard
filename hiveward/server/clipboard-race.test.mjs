import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClipboardNetwork, digest, waitFor } from './clipboard-test-fixture.mjs'

const enable = async (instance) => {
  const response = await instance.local('/api/clipboard/settings', {
    enabled: true,
    maxFileBytes: 1024
  })
  assert.equal(response.status, 200)
}

test('a local copy invalidates an older in-flight remote write', async () => {
  const network = await createClipboardNetwork()
  try {
    const a = await network.add('A')
    const b = await network.add('B', { writeDelay: 100, readDelay: 60 })
    await enable(a)
    await enable(b)
    const remoteText = 'older remote payload'
    const localText = 'newer local payload'
    const incoming = network.send('A', 'B', '/api/clipboard/push', {
      method: 'POST',
      body: { eventId: randomUUID(), origin: 'A', kind: 'text', text: remoteText }
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    b.adapter.copy({ kind: 'text', text: localText })
    assert.equal((await incoming).status, 200)
    await waitFor(async () => {
      const status = await b.local('/api/clipboard')
      return status.data.recent.some((event) => event.direction === 'sent' && !event.skipped)
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(b.adapter.writes.length, 0)
    assert.ok(digest(b.adapter.value().text) === digest(localText))
    const recent = (await b.local('/api/clipboard')).data.recent
    assert.ok(!recent.some((event) => event.direction === 'received'))
    console.log(
      'ACCEPT local versus remote race',
      JSON.stringify({
        remoteWrites: 0,
        finalSha256: digest(localText)
      })
    )
  } finally {
    await network.close()
  }
})

test(
  'disabling aborts an in-flight native write without recording receipt',
  { timeout: 2000 },
  async () => {
    const network = await createClipboardNetwork()
    try {
      const a = await network.add('A')
      const b = await network.add('B', { writeDelay: 100, readDelay: 100 })
      await enable(a)
      await enable(b)
      const incoming = network.send('A', 'B', '/api/clipboard/push', {
        method: 'POST',
        body: {
          eventId: randomUUID(),
          origin: 'A',
          kind: 'text',
          text: 'delayed remote payload'
        }
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      b.adapter.copy({ kind: 'text', text: 'local change with delayed read' })
      const disabled = await b.local('/api/clipboard/settings', {
        enabled: false,
        maxFileBytes: 1024
      })
      assert.equal(disabled.status, 200)
      assert.equal((await incoming).status, 200)
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(b.adapter.writes.length, 0)
      const recent = (await b.local('/api/clipboard')).data.recent
      assert.ok(!recent.some((event) => event.direction === 'received'))
      console.log(
        'ACCEPT in-flight disable',
        JSON.stringify({ nativeWrites: 0, receivedEvents: 0 })
      )
    } finally {
      await network.close()
    }
  }
)

test('disable cleanup is serialized before re-enable and new file receipt', async () => {
  const network = await createClipboardNetwork()
  try {
    const a = await network.add('A')
    const b = await network.add('B')
    await enable(a)
    await enable(b)
    const disabling = b.local('/api/clipboard/settings', {
      enabled: false,
      maxFileBytes: 1024
    })
    const enabling = b.local('/api/clipboard/settings', {
      enabled: true,
      maxFileBytes: 1024
    })
    assert.equal((await disabling).status, 200)
    assert.equal((await enabling).status, 200)
    const content = Buffer.from('post re-enable file payload')
    const source = join(network.root, 're-enabled.bin')
    await writeFile(source, content)
    a.adapter.copy({ kind: 'files', paths: [source] })
    await waitFor(() => b.adapter.writes.length === 1)
    assert.ok(digest(await readFile(b.adapter.value().paths[0])) === digest(content))
    const status = await b.local('/api/clipboard')
    assert.equal(status.data.settings.enabled, true)
    console.log(
      'ACCEPT serialized re-enable',
      JSON.stringify({
        enabled: true,
        bytes: content.length,
        sha256: digest(content)
      })
    )
  } finally {
    await network.close()
  }
})
