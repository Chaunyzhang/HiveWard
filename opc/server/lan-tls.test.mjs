import { WebSocket, WebSocketServer } from 'ws'
import { installTerminalWebSockets } from './terminal-websocket.mjs'
import { invitationCode, nonceCommitment } from './lan-invitation-verification.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { X509Certificate } from 'node:crypto'
import { createLan } from './lan.mjs'
import { loadLanCertificate, generateLanCertificate } from './lan-certificate.mjs'
import { tlsJson, socketFingerprint } from './lan-tls.mjs'

const send = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
const listen = async (server, port) => {
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
}
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })
const log = (label, value) => console.log(`${label}\n${JSON.stringify(value)}`)
async function json(port, path = '/api/machines', body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: r.status, data: await r.json() }
}

test('certificate identity persists at 0600; loss changes fingerprint; malformed identity fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-tls-cert-'))
  try {
    const a = loadLanCertificate(root)
    assert.equal(loadLanCertificate(root).fingerprint, a.fingerprint)
    assert.ok(new X509Certificate(a.cert).verify(new X509Certificate(a.cert).publicKey))
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(root, 'lan-identity.json'))).mode & 0o777, 0o600)
    }
    await unlink(join(root, 'lan-identity.json'))
    assert.notEqual(loadLanCertificate(root).fingerprint, a.fingerprint)
    await writeFile(join(root, 'lan-identity.json'), 'broken')
    assert.throws(() => loadLanCertificate(root))
    log('certificate persistence', {
      permissions: '0600',
      stableOnRestart: true,
      changedAfterLoss: true,
      corruptRejected: true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'two TLS instances, active MITM SAS, pin change refusal, plaintext denial, 1 GiB streaming',
  { timeout: 120000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hiveward-tls-acceptance-'))
    const machines = [],
      extra = []
    const build = async (id, port) => {
      const directory = join(root, id)
      await mkdir(directory)
      await writeFile(join(directory, 'machine.json'), JSON.stringify({ id, name: id }))
      const identity = loadLanCertificate(directory)
      const lan = createLan({ lanPort: port + 1, directory })
      const checkpoints = []
      let secureRequests = 0
      let received = 0,
        protocol,
        peerFingerprint,
        peakRss = 0
      const route = async (req, res, local = false) => {
        try {
          if (req.socket.encrypted) {
            secureRequests++
          }
          const url = new URL(req.url, 'http://test')
          if (
            local
              ? await lan.localRequest(req, res, url, route)
              : await lan.lanRequest(req, res, url)
          ) {
            return
          }
          protocol = req.socket.getProtocol?.()
          peerFingerprint = socketFingerprint(req.socket)
          if (url.pathname === '/api/upload') {
            let bytes = 0
            for await (const chunk of req) {
              bytes += chunk.length
              const boundary = [64, 256, 512, 1024][checkpoints.length]
              if (boundary && bytes >= boundary * 1024 * 1024) {
                checkpoints.push({ bytes, rss: process.memoryUsage().rss })
              }
              if (bytes % (1024 * 1024) < chunk.length) {
                peakRss = Math.max(peakRss, process.memoryUsage().rss)
              }
            }
            received += bytes
            send(res, 200, { bytes, protocol, peerFingerprint })
          } else if (url.pathname === '/api/overview') {
            send(res, 200, {
              health: { reachable: true },
              businesses: [],
              decisionsPending: 0,
              protocol
            })
          } else if (url.pathname === '/api/orca/terminals') {
            send(res, 200, { terminals: [] })
          } else {
            send(res, 200, {})
          }
        } catch (e) {
          send(res, e.status ?? 502, { error: { code: e.code, message: e.message } })
        }
      }
      const plain = createServer((req, res) => route(req, res))
      const secure = httpsServer(lan.tlsOptions, (req, res) => route(req, res))
      const local = createServer((req, res) => route(req, res, true))
      const stopStreams = installTerminalWebSockets({
        server: local,
        lanServer: secure,
        lan,
        fromThisMachine: () => true,
        streaming: {
          WebSocket,
          WebSocketServer,
          open(_handle, _size, emit) {
            queueMicrotask(() => {
              emit({ type: 'snapshot-start', payload: Buffer.from('{"cols":80,"rows":24}') })
              emit({ type: 'snapshot-end' })
            })
            return { input() {}, resize() {}, close() {} }
          }
        }
      })
      const machine = {
        stopStreams,
        id,
        port,
        directory,
        identity,
        lan,
        secure,
        plain,
        local,
        metrics: () => ({
          received,
          protocol,
          peerFingerprint,
          peakRss,
          secureRequests,
          checkpoints
        })
      }
      machines.push(machine)
      await listen(secure, port + 2)
      lan.setTlsPort(port + 2)
      await listen(plain, port + 1)
      await listen(local, port)
      return machine
    }
    try {
      const a = await build('TLS-A', 19107),
        b = await build('TLS-B', 19117)
      const attacker = loadLanCertificate(join(root, 'attacker'))
      const target = {
        address: '127.0.0.1:19118',
        tlsPort: 19119,
        fingerprint: b.identity.fingerprint
      }
      const spoofHello = createServer((_req, res) =>
        send(res, 200, { id: b.id, name: b.id, tlsPort: 19129, fingerprint: attacker.fingerprint })
      )
      const spoofTls = httpsServer(
        { ...attacker, requestCert: true, rejectUnauthorized: false },
        async (req, res) => {
          try {
            let raw = ''
            for await (const chunk of req) {
              raw += chunk
            }
            const data = await tlsJson(attacker, target, req.url, { body: JSON.parse(raw) })
            send(res, 200, data)
          } catch (e) {
            send(res, 502, { error: { message: e.message } })
          }
        }
      )
      extra.push(spoofHello, spoofTls)
      await listen(spoofHello, 19128)
      await listen(spoofTls, 19129)
      const attacked = await json(a.port, '/api/machines/invite', { address: '127.0.0.1:19128' })
      assert.equal(attacked.status, 200)
      const attackedIncoming = (await json(b.port)).data.invitations.find(
        (i) => i.id === attacked.data.id
      )
      assert.notEqual(attacked.data.verifyCode, attackedIncoming.verifyCode)
      log('active MITM separate TLS legs', {
        inviterCode: attacked.data.verifyCode,
        recipientCode: attackedIncoming.verifyCode,
        unequal: true
      })
      await json(a.port, `/api/machines/invitations/${attacked.data.id}/cancel`, {})
      const invited = await json(a.port, '/api/machines/invite', { address: '127.0.0.1:19118' })
      assert.equal(invited.status, 200)
      const incoming = (await json(b.port)).data.invitations.find((i) => i.id === invited.data.id)
      assert.match(invited.data.verifyCode, /^\d{6}$/)
      assert.equal(incoming.verifyCode, invited.data.verifyCode)
      assert.equal(
        (await json(b.port, `/api/machines/invitations/${invited.data.id}/accept`, {})).status,
        200
      )
      const peer = JSON.parse(await readFile(join(a.directory, 'peers.json')))[0]
      assert.equal(peer.fingerprint, b.identity.fingerprint)
      const overview = await json(a.port, '/api/m/TLS-B/api/overview')
      assert.equal(overview.status, 200)
      assert.match(overview.data.protocol, /^TLSv1\.[23]$/)
      assert.equal((await json(a.port)).data.machines.find((m) => m.id === b.id).secure, true)
      await assert.rejects(
        tlsJson(attacker, target, '/api/overview', { token: peer.outboundToken }),
        { code: 'tls_fingerprint_mismatch' }
      )
      log('verified organization channel', {
        codeA: invited.data.verifyCode,
        codeB: incoming.verifyCode,
        protocol: overview.data.protocol,
        destination: '127.0.0.1:19119',
        clientCertificateMatched: b.metrics().peerFingerprint === a.identity.fingerprint
      })
      for (const path of [
        '/api/overview',
        '/lan/organization/remove',
        '/lan/invitations',
        '/lan/probe'
      ]) {
        const r = await fetch(`http://127.0.0.1:19118${path}`, {
          method: path === '/api/overview' ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${peer.outboundToken}` }
        })
        assert.equal(r.status, 403)
      }
      log('plaintext allowlist', {
        hello: (await json(19118, '/lan/hello')).status,
        allProtectedPaths: 403
      })
      const terminal = new WebSocket(
        'ws://127.0.0.1:19107/api/m/TLS-B/orca/terminals/fixture/stream?cols=80&rows=24'
      )
      const terminalFrame = once(terminal, 'message')
      await once(terminal, 'open')
      assert.equal(JSON.parse((await terminalFrame)[0]).type, 'snapshot')
      terminal.close()
      await once(terminal, 'close')
      log('terminal stream', {
        localProtocol: 'ws',
        memberProtocol: 'wss',
        pinnedHandshake: 'passed',
        snapshotReceived: true
      })
      const before = process.memoryUsage().rss
      const bytes = 1024 * 1024 * 1024
      const upload = request('http://127.0.0.1:19107/api/m/TLS-B/api/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': bytes }
      })
      const response = new Promise((resolve, reject) => {
        upload.once('error', reject)
        upload.once('response', async (res) => {
          let raw = ''
          for await (const chunk of res) {
            raw += chunk
          }
          resolve({ status: res.statusCode, data: JSON.parse(raw) })
        })
      })
      const block = Buffer.alloc(65536, 0x5a)
      await pipeline(
        Readable.from(
          (function* () {
            for (let sent = 0; sent < bytes; sent += block.length) {
              yield block
            }
          })()
        ),
        upload
      )
      const transferred = await response
      assert.equal(transferred.status, 200)
      assert.equal(transferred.data.bytes, bytes)
      const growth = b.metrics().peakRss - before
      assert.ok(growth < 128 * 1024 * 1024, `RSS growth ${growth}`)
      log('1 GiB generated upload, no file', {
        bytes,
        protocol: transferred.data.protocol,
        baselineRss: before,
        peakRss: b.metrics().peakRss,
        growthBytes: growth,
        checkpoints: b.metrics().checkpoints,
        limitBytes: 128 * 1024 * 1024
      })
      const priorRequests = b.metrics().secureRequests
      const replacement = generateLanCertificate()
      b.secure.setSecureContext(replacement)
      const denied = await json(a.port, '/api/m/TLS-B/api/overview')
      assert.equal(denied.data.error.code, 'tls_fingerprint_mismatch')
      assert.equal(
        b.metrics().secureRequests,
        priorRequests,
        'No HTTP headers or bearer sent to substituted certificate'
      )
      const status = (await json(a.port)).data.machines.find((m) => m.id === b.id)
      assert.equal(status.secure, false)
      assert.equal(status.error.code, 'tls_fingerprint_mismatch')
      log('certificate swapped after pairing', {
        response: denied,
        machine: { status: status.status, secure: status.secure, error: status.error }
      })
    } finally {
      for (const machine of machines) {
        machine.stopStreams()
      }
      await Promise.all(machines.map((m) => m.lan.close()))
      await Promise.all(
        [...extra, ...machines.flatMap((m) => [m.local, m.plain, m.secure])].map(close)
      )
      await rm(root, { recursive: true, force: true })
      log('TLS cleanup', { removed: root, serversClosed: true })
    }
  }
)

test('SAS binds roles, invitation, both certificates and both nonces; commitment binds reveal', () => {
  const inputs = ['a'.repeat(64), 'b'.repeat(64), 'invitation', 'c'.repeat(64), 'd'.repeat(64)]
  const code = invitationCode(...inputs)
  for (let i = 0; i < inputs.length; i++) {
    const changed = [...inputs]
    changed[i] = 'changed'
    assert.notEqual(invitationCode(...changed), code)
  }
  assert.notEqual(nonceCommitment(inputs[3]), nonceCommitment('different'))
})
