// Transport fixture: validates shared routing/bytes independently of a desktop browser.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

if (process.env.HIVEWARD_TRANSPORT_FIXTURE) {
  const { startBridge } = await import('../hiveward-bridge.mjs')
  const server = await startBridge({
    extraRoutes: [
      [
        'PATCH',
        /^\/api\/fixture\/echo$/,
        async (req, _params, url) => {
          const chunks = []
          for await (const c of req) {chunks.push(c)}
          return {
            method: req.method,
            query: url.search,
            contentType: req.headers['content-type'],
            bytes: Buffer.concat(chunks).toString('hex')
          }
        }
      ],
      [
        'GET',
        /^\/api\/fixture\/png$/,
        async () => ({ raw: Buffer.from('89504e470d0a1a0a00ff801122', 'hex'), type: 'image/png' })
      ],
      [
        'GET',
        /^\/api\/fixture\/error$/,
        async () => {
          throw Object.assign(new Error('fixture'), { status: 418, code: 'fixture_error' })
        }
      ]
    ]
  })
  process.once('SIGTERM', () => {
    server.close(() => process.exit(0))
    server.closeAllConnections()
  })
} else {
  const dir = mkdtempSync(join(tmpdir(), 'hiveward-transport-')),
    children = []
  const a = 'http://127.0.0.1:18791',
    b = 'http://127.0.0.1:18793'
  const json = async (base, path, body) => {
    const r = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: r.status, body: await r.json() }
  }
  try {
    for (const [index, port] of [18791, 18793].entries()) {
      const child = spawn(process.execPath, [import.meta.filename], {
        env: {
          ...process.env,
          HIVEWARD_TRANSPORT_FIXTURE: '1',
          HIVEWARD_DATA_DIR: join(dir, String(index)),
          HIVEWARD_PORT: String(port),
          HIVEWARD_LAN_PORT: String(port + 1)
        },
        stdio: ['ignore', 'pipe', 'inherit']
      })
      children.push(child)
      for (let i = 0; ; i++) {
        try {
          await json(`http://127.0.0.1:${port}`, '/api/machines')
          break
        } catch (e) {
          if (i > 50 || child.exitCode !== null) {throw e}
          await sleep(100)
        }
      }
    }
    const code = (await json(a, '/api/machines/pair-code', {})).body.code
    const paired = await json(b, '/api/machines/pair', { address: '127.0.0.1:18792', code })
    assert.equal(paired.status, 200)
    const id = paired.body.id,
      root = `${b}/api/m/${id}`
    const bytes = Buffer.from([0, 255, 128, 34, 10, 13])
    const response = await fetch(`${root  }/fixture/echo?x=a%2Fb&x=2&empty=`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes
    })
    assert.deepEqual(await response.json(), {
      method: 'PATCH',
      query: '?x=a%2Fb&x=2&empty=',
      contentType: 'application/octet-stream',
      bytes: bytes.toString('hex')
    })
    console.log(
      'PASS extraRoutes: PATCH + duplicate/escaped query + binary request + content-type preserved'
    )
    const png = await fetch(`${root  }/fixture/png`)
    assert.equal(png.headers.get('content-type'), 'image/png')
    assert.equal(Buffer.from(await png.arrayBuffer()).toString('hex'), '89504e470d0a1a0a00ff801122')
    console.log('PASS extraRoutes: PNG response bytes and content-type preserved')
    const failed = await fetch(`${root  }/fixture/error`)
    assert.equal(failed.status, 418)
    assert.deepEqual(await failed.json(), { error: { code: 'fixture_error', message: 'fixture' } })
    console.log('PASS remote HTTP 418 and JSON error preserved')
    const peers = JSON.parse(readFileSync(join(dir, '0', 'peers.json')))
    const remoteId = peers[0].id
    await json(a, `/api/machines/${remoteId}/unpair`, {})
    const denied = await fetch('http://127.0.0.1:18792/api/fixture/png', {
      headers: { authorization: `Bearer ${peers[0].inboundToken}` }
    })
    assert.equal(denied.status, 401)
    console.log('PASS unpair revokes extraRoutes access')
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null) {return}
        const exit = once(child, 'exit')
        child.kill()
        await exit
      })
    )
    rmSync(dir, { recursive: true, force: true })
  }
}
