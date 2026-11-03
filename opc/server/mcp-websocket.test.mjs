import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMcpService } from './mcp-shares.mjs'
import { createMcpWebSocketHandler } from './mcp-websocket.mjs'

const stdioFixture = fileURLToPath(new URL('./tests/mcp-stdio-fixture.mjs', import.meta.url))
const closeSocket = (ws) => {
  const closed = once(ws, 'close')
  ws.close()
  return closed
}
const request = async (ws, id, method = 'initialize', text) => {
  const incoming = once(ws, 'message')
  ws.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(method === 'tools/call' ? { params: { name: 'echo', arguments: { text } } } : {})
    })
  )
  return JSON.parse((await incoming)[0].toString())
}
const connectError = async (url) => {
  const ws = new WebSocket(url)
  const closed = once(ws, 'close')
  const incoming = once(ws, 'message')
  try {
    await once(ws, 'open')
    const [raw] = await incoming
    await closed
    return JSON.parse(raw.toString())
  } finally {
    ws.terminate()
  }
}

async function fixture({ remote = false, peer = null, pingInterval, idleTimeout } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'opc-mcp-ws-'))
  const events = []
  const service = createMcpService({ directory, recordEvent: (event) => events.push(event) })
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local')
      if (!(await service.handle(req, res, url, { remote: false, peer: null }))) {
        res.writeHead(404)
        res.end()
      }
    } catch (error) {
      res.writeHead(error.status ?? 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: error.code, message: error.message } }))
    }
  })
  const lan = {
    authenticate: () => peer,
    onMembershipChange: () => () => {}
  }
  const sockets = createMcpWebSocketHandler({
    server,
    lan,
    fromThisMachine: () => true,
    service,
    ...(pingInterval ? { pingInterval, idleTimeout } : {})
  })
  server.on('upgrade', (req, socket, head) => {
    if (!sockets.accept(req, socket, head, remote)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    service,
    events,
    base,
    async save(body) {
      const response = await fetch(`${base}/api/mcp/shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (response.status !== 200) {
        throw new Error(await response.text())
      }
      return response.json()
    },
    async close() {
      await service.close()
      sockets.close()
      await new Promise((resolve) => server.close(resolve))
      server.closeAllConnections()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

test('MCP WebSocket reports missing, disabled, forbidden, start and concurrency failures', async () => {
  const local = await fixture()
  const remote = await fixture({ remote: true, peer: { id: 'A', name: 'Machine A' } })
  try {
    assert.equal(
      (await connectError(`${local.base.replace('http', 'ws')}/api/mcp/missing/connect`)).code,
      'not_shared'
    )
    await local.save({
      name: 'off',
      enabled: false,
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture]
    })
    assert.equal(
      (await connectError(`${local.base.replace('http', 'ws')}/api/mcp/off/connect`)).code,
      'disabled'
    )
    await local.save({
      name: 'broken',
      enabled: true,
      transport: 'stdio',
      command: join('/tmp', 'definitely-not-an-mcp-command')
    })
    assert.equal(
      (await connectError(`${local.base.replace('http', 'ws')}/api/mcp/broken/connect`)).code,
      'start_failed'
    )
    await remote.save({
      name: 'private',
      enabled: true,
      transport: 'http',
      url: 'http://localhost:9/mcp',
      allowMachines: ['B']
    })
    assert.equal(
      (await connectError(`${remote.base.replace('http', 'ws')}/api/mcp/private/connect`)).code,
      'forbidden'
    )
    await local.save({
      name: 'echo',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture]
    })
    const url = `${local.base.replace('http', 'ws')}/api/mcp/echo/connect`
    const clients = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const ws = new WebSocket(url)
        await once(ws, 'open')
        return ws
      })
    )
    try {
      const responses = await Promise.all(clients.map((ws, index) => request(ws, index + 1)))
      assert.deepEqual(
        responses.map((response) => response.id),
        [1, 2, 3, 4]
      )
      assert.equal((await connectError(url)).code, 'too_many_sessions')
      const isolated = await Promise.all(
        clients.map((ws, index) => request(ws, 100 + index, 'tools/call', `session-${index}`))
      )
      assert.deepEqual(
        isolated.map((response) => response.result.content[0].text),
        ['session-0', 'session-1', 'session-2', 'session-3']
      )
    } finally {
      await Promise.all(clients.map(closeSocket))
    }
    assert.ok(local.events.some((event) => event.title === '本机 连上了 MCP：echo'))
    assert.ok(local.events.some((event) => /本机 断开 MCP：echo（用时 /.test(event.title)))
  } finally {
    await local.close()
    await remote.close()
  }
})

test('MCP WebSocket idle timeout ignores automatic pongs and rejects nonmembers', async () => {
  const local = await fixture({ pingInterval: 20, idleTimeout: 60 })
  const denied = await fixture({ remote: true, peer: null })
  try {
    await local.save({
      name: 'http',
      enabled: true,
      transport: 'http',
      url: 'http://localhost:9/mcp'
    })
    const ws = new WebSocket(`${local.base.replace('http', 'ws')}/api/mcp/http/connect`)
    await once(ws, 'open')
    await once(ws, 'close')
    const stranger = new WebSocket(`${denied.base.replace('http', 'ws')}/api/mcp/http/connect`)
    stranger.on('error', () => {})
    const [, response] = await once(stranger, 'unexpected-response')
    assert.equal(response.statusCode, 403)
    stranger.terminate()
  } finally {
    await local.close()
    await denied.close()
  }
})
