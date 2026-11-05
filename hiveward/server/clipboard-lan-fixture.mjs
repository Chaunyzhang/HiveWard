import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { createLan } from './lan.mjs'
import { createClipboardService } from './clipboard.mjs'
import { createFakeAdapter } from './clipboard-test-fixture.mjs'

export async function freePorts(count) {
  const ports = []
  for (let index = 0; index < count; index++) {
    const server = createNetServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    ports.push(server.address().port)
    await new Promise((resolve) => server.close(resolve))
  }
  return ports
}

export async function createTlsClipboardInstance(root, id, ports) {
  const directory = join(root, id, 'data')
  const home = join(root, id, 'home')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'machine.json'), JSON.stringify({ id, name: id }))
  const lan = createLan({ lanPort: ports.plain, directory })
  const adapter = createFakeAdapter()
  const service = createClipboardService({
    directory,
    home,
    machine: lan.localMachine(),
    members: lan.onlineMembers,
    request: lan.memberRequest,
    adapter,
    cacheOptions: { cleanupInterval: 60000 }
  })
  const protocols = new Set()
  const route = async (req, res, remote = false) => {
    try {
      const url = new URL(req.url, 'http://x')
      if (
        remote ? await lan.lanRequest(req, res, url) : await lan.localRequest(req, res, url, route)
      ) {
        return
      }
      if (url.pathname === '/api/overview') {
        json(res, { health: { reachable: true }, businesses: [], decisionsPending: 0 })
        return
      }
      if (url.pathname === '/api/hiveward/terminals') {
        json(res, { terminals: [] })
        return
      }
      const peer = remote ? lan.authenticate(req) : null
      if (await service.handle(req, res, url, { remote, peer })) {
        if (remote) {
          protocols.add(req.socket.getProtocol())
        }
        return
      }
      json(res, {})
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(error.status ?? 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: error.code ?? 'failed' } }))
      } else {
        res.destroy()
      }
    }
  }
  const local = createServer((req, res) => route(req, res))
  const plain = createServer((req, res) => route(req, res, true))
  const tls = createTlsServer(lan.tlsOptions, (req, res) => route(req, res, true))
  await listen(tls, ports.tls)
  lan.setTlsPort(ports.tls)
  await listen(local, ports.local)
  await listen(plain, ports.plain)
  service.start()
  return {
    id,
    adapter,
    service,
    protocols,
    members: () => lan.onlineMembers(),
    local: (path, body) => localRequest(ports.local, path, body),
    close: async () => {
      await service.close()
      const discovery = lan.close()
      await Promise.all([close(local), close(plain), close(tls)])
      await discovery
    }
  }
}

async function listen(server, port) {
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })
}

async function localRequest(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: response.status, data: await response.json() }
}

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
