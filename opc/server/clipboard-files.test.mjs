import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createClipboardNetwork, digest, waitFor } from './clipboard-test-fixture.mjs'

const cacheRoot = (instance) => join(instance.home, 'HiveWard Clipboard Cache')
const enable = async (instance, maxFileBytes) => {
  const response = await instance.local('/api/clipboard/settings', { enabled: true, maxFileBytes })
  assert.equal(response.status, 200)
}

test('files and nested directories arrive in the isolated clipboard cache', async () => {
  const network = await createClipboardNetwork()
  try {
    const a = await network.add('A')
    const b = await network.add('B')
    await enable(a, 1024 * 1024)
    await enable(b, 1024 * 1024)
    const source = join(network.root, 'source')
    const folder = join(source, 'folder')
    await mkdir(join(folder, 'nested'), { recursive: true })
    await mkdir(join(folder, 'empty'))
    const first = Buffer.from('clipboard file payload one')
    const second = Buffer.from('clipboard file payload two')
    const single = join(source, 'single.bin')
    await writeFile(single, first)
    await writeFile(join(folder, 'nested', 'inside.bin'), second)
    a.adapter.copy({ kind: 'files', paths: [single, folder] })
    await waitFor(() => b.adapter.writes.length === 1)
    const paths = b.adapter.value().paths
    assert.equal(paths.length, 2)
    assert.ok(paths.every((path) => path.startsWith(cacheRoot(b))))
    const singleTarget = paths.find((path) => basename(path) === 'single.bin')
    const folderTarget = paths.find((path) => basename(path) === 'folder')
    assert.ok(singleTarget && folderTarget)
    assert.ok(digest(await readFile(singleTarget)) === digest(first))
    assert.ok(digest(await readFile(join(folderTarget, 'nested', 'inside.bin'))) === digest(second))
    assert.ok((await stat(join(folderTarget, 'empty'))).isDirectory())
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(a.adapter.writes.length, 0)
    console.log(
      'ACCEPT files',
      JSON.stringify({
        count: paths.length,
        bytes: first.length + second.length,
        sha256: digest(Buffer.concat([first, second])),
        emptyDirectory: true,
        echoWrites: 0
      })
    )
  } finally {
    await network.close()
  }
})

test('oversized files only notify and never upload or populate the cache', async () => {
  const network = await createClipboardNetwork()
  try {
    const a = await network.add('A')
    const b = await network.add('B')
    await enable(a, 16)
    await enable(b, 16)
    const source = join(network.root, 'large')
    await mkdir(source)
    const first = Buffer.alloc(10, 3)
    const second = Buffer.alloc(10, 5)
    const one = join(source, 'one.bin')
    const two = join(source, 'two.bin')
    await writeFile(one, first)
    await writeFile(two, second)
    a.adapter.copy({ kind: 'files', paths: [one, two] })
    await waitFor(() => b.notices.length === 1)
    assert.equal(b.adapter.writes.length, 0)
    assert.equal(b.notices[0].count, 2)
    assert.equal(b.notices[0].bytes, 20)
    assert.equal(existsSync(cacheRoot(b)), false)
    assert.ok(!b.requests.some((path) => path.endsWith('/entry')))
    const recent = (await b.local('/api/clipboard')).data.recent[0]
    assert.equal(recent.skipped, 'files_too_large')
    console.log(
      'ACCEPT oversized files',
      JSON.stringify({
        count: 2,
        bytes: 20,
        sha256: digest(Buffer.concat([first, second])),
        uploadedEntries: 0,
        cacheCreated: false
      })
    )
  } finally {
    await network.close()
  }
})

test('disabling stops monitoring and removes cached files immediately', async () => {
  const network = await createClipboardNetwork()
  try {
    const a = await network.add('A')
    const b = await network.add('B')
    await enable(a, 1024)
    await enable(b, 1024)
    const source = join(network.root, 'disable.bin')
    await writeFile(source, Buffer.from('cache cleanup payload'))
    a.adapter.copy({ kind: 'files', paths: [source] })
    await waitFor(() => b.adapter.writes.length === 1)
    assert.equal(existsSync(cacheRoot(b)), true)
    const disabled = await b.local('/api/clipboard/settings', {
      enabled: false,
      maxFileBytes: 1024
    })
    assert.equal(disabled.status, 200)
    assert.equal(b.adapter.watching(), false)
    assert.equal(existsSync(cacheRoot(b)), false)
    const reads = b.adapter.reads()
    b.adapter.copy({ kind: 'text', text: 'must not send while disabled' })
    a.adapter.copy({ kind: 'text', text: 'must not receive while disabled' })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(b.adapter.reads(), reads)
    assert.equal(b.adapter.writes.length, 1)
    assert.equal(a.adapter.writes.length, 0)
    console.log(
      'ACCEPT disable',
      JSON.stringify({ watching: false, cacheExists: false, newWrites: 0 })
    )
  } finally {
    await network.close()
  }
})

test('an older file transfer cannot overwrite a later text arrival', async () => {
  const network = await createClipboardNetwork()
  try {
    const a = await network.add('A')
    const b = await network.add('B')
    await enable(a, 1024)
    await enable(b, 1024)
    const content = Buffer.from('stale transfer payload')
    const eventId = randomUUID()
    const manifest = {
      eventId,
      origin: 'A',
      kind: 'files',
      count: 1,
      totalBytes: content.length,
      entries: [{ path: 'stale.bin', type: 'file', size: content.length }]
    }
    assert.equal(
      (
        await network.send('A', 'B', '/api/clipboard/files', {
          method: 'POST',
          body: manifest
        })
      ).status,
      200
    )
    const text = 'later text arrival'
    assert.equal(
      (
        await network.send('A', 'B', '/api/clipboard/push', {
          method: 'POST',
          body: { eventId: randomUUID(), origin: 'A', kind: 'text', text }
        })
      ).status,
      200
    )
    await waitFor(() => b.adapter.writes.length === 1)
    assert.equal(
      (
        await network.send('A', 'B', `/api/clipboard/files/${eventId}/entry?index=0`, {
          method: 'POST',
          body: content,
          headers: { 'content-type': 'application/octet-stream', 'content-length': content.length }
        })
      ).status,
      200
    )
    const committed = await network.send('A', 'B', `/api/clipboard/files/${eventId}/commit`, {
      method: 'POST',
      body: {}
    })
    assert.equal(committed.status, 200)
    assert.equal(committed.data.applied, false)
    assert.equal(b.adapter.writes.length, 1)
    assert.ok(digest(b.adapter.value().text) === digest(text))
    console.log(
      'ACCEPT stale transfer',
      JSON.stringify({
        applied: committed.data.applied,
        finalSha256: digest(text),
        fileBytes: content.length
      })
    )
  } finally {
    await network.close()
  }
})

test('expired orphaned cache directories are removed on startup', async () => {
  const network = await createClipboardNetwork()
  try {
    const orphan = join(network.root, 'B', 'home', 'HiveWard Clipboard Cache', randomUUID())
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'orphan.bin'), Buffer.from('orphan cache payload'))
    const expired = new Date(Date.now() - 120000)
    await utimes(orphan, expired, expired)
    const b = await network.add('B')
    await waitFor(() => !existsSync(orphan))
    assert.equal(existsSync(orphan), false)
    assert.equal(b.adapter.writes.length, 0)
    console.log('ACCEPT orphan cache cleanup', JSON.stringify({ removed: true, nativeWrites: 0 }))
  } finally {
    await network.close()
  }
})
