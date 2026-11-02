import { loadLanCertificate } from './lan-certificate.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

if (process.env.OPC_IDENTITY_LAN_FIXTURE) {
  const { startBridge } = await import('./orca-bridge.mjs')
  const server = await startBridge()
  const stop = () => {
    server.close(() => process.exit(0))
    server.closeAllConnections()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} else {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  async function freePort() {
    const server = createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address()
    await new Promise((resolve) => server.close(resolve))
    return port
  }

  test('LAN forwards timeline cursors and project logo bytes', { timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-identity-lan-'))
    const children = []
    const sockets = new Set()
    const runtime = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let buffer = ''
      socket.on('data', (data) => {
        buffer += data.toString()
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const request = JSON.parse(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          let result
          if (request.method === 'repo.list') {
            result = { repos: [] }
          }
          if (request.method === 'repo.add') {
            result = {
              repo: {
                id: 'repo-test',
                path: request.params.path,
                kind: request.params.kind,
                displayName: request.params.displayName
              }
            }
          }
          if (request.method === 'status.get') {
            result = { appVersion: 'test', graphStatus: 'ready' }
          }
          if (request.method === 'terminal.list') {
            result = { terminals: [] }
          }
          if (request.method === 'worktree.list') {
            result = { worktrees: [] }
          }
          if (request.method === 'orchestration.runList') {
            result = { runs: [] }
          }
          if (request.method === 'orchestration.inbox') {
            result = { messages: [] }
          }
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: result !== undefined,
              result,
              error:
                result === undefined
                  ? { code: 'method_not_found', message: request.method }
                  : undefined
            })}\n`
          )
        }
      })
    })
    try {
      const socketPath = join(root, 'runtime.sock')
      runtime.listen(socketPath)
      await once(runtime, 'listening')
      const metadata = join(root, 'runtime.json')
      await writeFile(
        metadata,
        JSON.stringify({
          authToken: 'identity-lan-test',
          transports: [{ kind: 'unix', endpoint: socketPath }]
        })
      )
      const project = join(root, 'project')
      await mkdir(join(project, 'resources'), { recursive: true })
      await writeFile(
        join(project, 'package.json'),
        JSON.stringify({ productName: 'Remote Product' })
      )
      const png = Buffer.from('89504e470d0a1a0a00ff801122', 'hex')
      await writeFile(join(project, 'resources', 'icon.png'), png)
      const [aPort, aLanPort, bPort, bLanPort] = await Promise.all([
        freePort(),
        freePort(),
        freePort(),
        freePort()
      ])
      const aDir = join(root, 'a')
      const bDir = join(root, 'b')
      await mkdir(aDir, { recursive: true })
      await mkdir(bDir, { recursive: true })
      const aIdentity = loadLanCertificate(aDir)
      const bIdentity = loadLanCertificate(bDir)
      const aToB = 'a'.repeat(64)
      const bToA = 'b'.repeat(64)
      await writeFile(join(aDir, 'machine.json'), JSON.stringify({ id: 'A', name: 'A' }))
      await writeFile(join(bDir, 'machine.json'), JSON.stringify({ id: 'B', name: 'B' }))
      await writeFile(join(aDir, 'businesses.json'), '[]')
      await writeFile(
        join(aDir, 'peers.json'),
        JSON.stringify([
          {
            id: 'B',
            name: 'B',
            address: `127.0.0.1:${bLanPort}`,
            tlsPort: bLanPort + 1, fingerprint: bIdentity.fingerprint,
            inboundToken: bToA,
            outboundToken: aToB
          }
        ])
      )
      await writeFile(
        join(bDir, 'peers.json'),
        JSON.stringify([
          {
            id: 'A',
            name: 'A',
            address: `127.0.0.1:${aLanPort}`,
            tlsPort: aLanPort + 1, fingerprint: aIdentity.fingerprint,
            inboundToken: aToB,
            outboundToken: bToA
          }
        ])
      )
      const now = new Date().toISOString()
      await writeFile(
        join(bDir, 'businesses.json'),
        JSON.stringify([
          {
            id: 'p1',
            name: 'legacy fake',
            workspacePath: project,
            leaderAgent: 'claude',
            priority: 2,
            status: 'active',
            authority: '',
            runIds: [],
            updatedAt: now
          }
        ])
      )
      await writeFile(
        join(bDir, 'timeline.json'),
        JSON.stringify([
          {
            id: 'event-1',
            ts: '2026-01-01T00:00:00.000Z',
            businessId: 'p1',
            kind: 'task',
            title: 'older'
          },
          {
            id: 'event-2',
            ts: '2026-01-02T00:00:00.000Z',
            businessId: 'p1',
            kind: 'task',
            title: 'newer'
          }
        ])
      )
      async function start(name, port, lanPort, directory) {
        const child = spawn(process.execPath, [new URL(import.meta.url).pathname], {
          env: {
            ...process.env,
            OPC_IDENTITY_LAN_FIXTURE: '1',
            ORCA_BACKGROUND_LAUNCH: '1',
            OPC_PORT: String(port),
            OPC_LAN_PORT: String(lanPort),
            OPC_DATA_DIR: directory,
            ORCA_RUNTIME_META: metadata
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
        children.push(child)
        let output = ''
        child.stdout.on('data', (data) => (output += data.toString()))
        child.stderr.on('data', (data) => (output += data.toString()))
        for (let n = 0; n < 100; n++) {
          if (output.includes('bridge on')) {
            return
          }
          if (child.exitCode !== null) {
            throw new Error(`${name}: ${output}`)
          }
          await pause(50)
        }
        throw new Error(`${name} startup timed out: ${output}`)
      }
      await start('B', bPort, bLanPort, bDir)
      await start('A', aPort, aLanPort, aDir)
      const base = `http://127.0.0.1:${aPort}/api/m/B`
      const first = await fetch(`${base}/api/timeline?businessId=p1&limit=1`)
      assert.equal(first.status, 200)
      const page = await first.json()
      assert.deepEqual(
        page.items.map((event) => event.id),
        ['event-2']
      )
      assert.ok(page.nextCursor)
      const second = await fetch(
        `${base}/api/timeline?businessId=p1&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`
      )
      assert.deepEqual(
        (await second.json()).items.map((event) => event.id),
        ['event-1']
      )
      const logo = await fetch(`${base}/api/businesses/p1/logo?v=123`)
      assert.equal(logo.status, 200)
      assert.equal(logo.headers.get('content-type'), 'image/png')
      assert.equal(Buffer.from(await logo.arrayBuffer()).toString('hex'), png.toString('hex'))
      console.log('PASS LAN /api/m/B/api/timeline pagination and /api/businesses/p1/logo bytes')
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null) {
            return
          }
          const exited = once(child, 'exit')
          child.kill('SIGTERM')
          await exited
        })
      )
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise((resolve) => runtime.close(resolve))
      await rm(root, { recursive: true, force: true })
    }
  })
}
