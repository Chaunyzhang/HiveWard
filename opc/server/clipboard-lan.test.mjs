import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createTlsClipboardInstance, freePorts } from './clipboard-lan-fixture.mjs'
import { digest, waitFor } from './clipboard-test-fixture.mjs'

test(
  'paired TLS instances sync text, PNG and a file through the production member transport',
  {
    timeout: 30000
  },
  async () => {
    const root = await mkdtemp('/tmp/hiveward-clipboard-lan-')
    const previousDiscovery = process.env.OPC_DISCOVERY_PORT
    const instances = []
    try {
      const ports = await freePorts(7)
      process.env.OPC_DISCOVERY_PORT = String(ports[6])
      const a = await createTlsClipboardInstance(root, 'TLS-A', {
        local: ports[0],
        plain: ports[1],
        tls: ports[2]
      })
      instances.push(a)
      const b = await createTlsClipboardInstance(root, 'TLS-B', {
        local: ports[3],
        plain: ports[4],
        tls: ports[5]
      })
      instances.push(b)
      const invited = await a.local('/api/machines/invite', {
        address: `127.0.0.1:${ports[4]}`
      })
      assert.equal(invited.status, 200)
      const machines = await b.local('/api/machines')
      const incoming = machines.data.invitations.find((item) => item.id === invited.data.id)
      assert.ok(incoming && incoming.verifyCode === invited.data.verifyCode)
      const accepted = await b.local(`/api/machines/invitations/${invited.data.id}/accept`, {})
      assert.equal(accepted.status, 200)
      await waitFor(() => a.members().length === 1 && b.members().length === 1, 10000)
      for (const instance of instances) {
        const enabled = await instance.local('/api/clipboard/settings', {
          enabled: true,
          maxFileBytes: 1024 * 1024
        })
        assert.equal(enabled.status, 200)
      }

      const text = 'real TLS text payload'
      a.adapter.copy({ kind: 'text', text, html: `<b>${text}</b>` })
      await waitFor(() => b.adapter.writes.length === 1)
      assert.ok(digest(b.adapter.value().text) === digest(text))

      const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.from('real TLS png payload')
      ])
      a.adapter.copy({ kind: 'image', png })
      await waitFor(() => b.adapter.writes.length === 2)
      assert.ok(digest(b.adapter.value().png) === digest(png))

      const fileBytes = Buffer.from('real TLS streamed file payload')
      const source = join(root, 'tls-file.bin')
      await writeFile(source, fileBytes)
      a.adapter.copy({ kind: 'files', paths: [source] })
      await waitFor(() => b.adapter.writes.length === 3)
      const receivedPath = b.adapter.value().paths[0]
      assert.ok(basename(receivedPath) === basename(source))
      assert.ok(digest(await readFile(receivedPath)) === digest(fileBytes))
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(a.adapter.writes.length, 0)
      assert.ok([...b.protocols].every((protocol) => /^TLSv1\.[23]$/.test(protocol)))
      console.log(
        'ACCEPT real TLS clipboard',
        JSON.stringify({
          protocol: [...b.protocols],
          text: { bytes: Buffer.byteLength(text), sha256: digest(text) },
          image: { bytes: png.length, sha256: digest(png) },
          files: { count: 1, bytes: fileBytes.length, sha256: digest(fileBytes) },
          echoWrites: 0
        })
      )
    } finally {
      for (const instance of instances.toReversed()) {
        await instance.close()
      }
      if (previousDiscovery === undefined) {
        delete process.env.OPC_DISCOVERY_PORT
      } else {
        process.env.OPC_DISCOVERY_PORT = previousDiscovery
      }
      await rm(root, { recursive: true, force: true })
    }
  }
)
