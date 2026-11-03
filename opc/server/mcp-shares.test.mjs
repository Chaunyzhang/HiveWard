import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createMcpService } from './mcp-shares.mjs'

async function call(
  service,
  method,
  path,
  body,
  { remote = false, peer = null, agent = false } = {}
) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = method
  req.headers = agent ? { 'x-opc-caller': 'agent' } : {}
  const res = {
    status: 200,
    writeHead(status) {
      this.status = status
    },
    end(raw) {
      this.body = raw ? JSON.parse(raw) : null
    }
  }
  const url = new URL(path, 'http://local')
  const handled = await service.handle(req, res, url, { remote, peer })
  assert.equal(handled, true)
  return res.body
}

test('MCP shares preserve secrets, validate loopback URLs and persist atomically at 0600', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opc-mcp-shares-'))
  const events = []
  try {
    const service = createMcpService({ directory, recordEvent: (event) => events.push(event) })
    const saved = await call(service, 'POST', '/api/mcp/shares', {
      name: 'echo-1',
      description: 'test',
      enabled: true,
      transport: 'stdio',
      command: '/private/tool path/run',
      args: ['--token', 'argument-secret'],
      env: { TOKEN: 'environment-secret' }
    })
    assert.deepEqual(saved.envKeys, ['TOKEN'])
    assert.equal(saved.env, undefined)
    assert.equal(saved.sessions, 0)
    const updated = await call(service, 'POST', '/api/mcp/shares', {
      name: 'echo-1',
      enabled: false,
      transport: 'stdio',
      command: '/private/tool path/run',
      args: ['--token', 'argument-secret']
    })
    assert.deepEqual(updated.envKeys, ['TOKEN'])
    assert.equal(updated.enabled, false)
    const listed = await call(service, 'GET', '/api/mcp/shares')
    assert.equal(JSON.stringify(listed).includes('environment-secret'), false)
    assert.equal(JSON.stringify(listed).includes('argument-secret'), true)
    const stored = JSON.parse(await readFile(join(directory, 'mcp-shares.json'), 'utf8'))
    assert.equal(stored[0].env.TOKEN, 'environment-secret')
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(directory, 'mcp-shares.json'))).mode & 0o777, 0o600)
    }
    await assert.rejects(
      call(service, 'POST', '/api/mcp/shares', {
        name: 'Bad_Name',
        enabled: true,
        transport: 'stdio',
        command: 'x'
      }),
      { code: 'invalid_name' }
    )
    for (const url of ['http://example.com/mcp', 'file:///tmp/mcp', 'http://127.0.0.2/mcp']) {
      await assert.rejects(
        call(service, 'POST', '/api/mcp/shares', {
          name: 'http-test',
          enabled: true,
          transport: 'http',
          url
        }),
        { code: 'invalid_url' }
      )
    }
    await call(service, 'POST', '/api/mcp/shares/echo-1/remove', {})
    assert.deepEqual(await call(service, 'GET', '/api/mcp/shares'), [])
    assert.deepEqual(
      events.map((event) => event.title),
      ['新增 MCP：echo-1', '关闭 MCP：echo-1', '删除 MCP 共享：echo-1']
    )
    await service.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('MCP shares are local-only and available is filtered and redacted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opc-mcp-acl-'))
  try {
    const service = createMcpService({ directory, recordEvent: () => {} })
    for (const [name, allowMachines] of [
      ['everyone', undefined],
      ['allowed', ['A']],
      ['denied', ['B']],
      ['disabled', undefined]
    ]) {
      await call(service, 'POST', '/api/mcp/shares', {
        name,
        enabled: name !== 'disabled',
        transport: 'http',
        url: 'http://localhost:1234/mcp?private=query',
        ...(allowMachines ? { allowMachines } : {}),
        env: { SECRET: 'not-in-available' }
      })
    }
    const member = { id: 'A', name: 'Machine A' }
    assert.deepEqual(
      await call(service, 'GET', '/api/mcp/available', undefined, { remote: true, peer: member }),
      [
        { name: 'allowed', transport: 'http' },
        { name: 'everyone', transport: 'http' }
      ]
    )
    assert.equal((await call(service, 'GET', '/api/mcp/available')).length, 3)
    await assert.rejects(
      call(service, 'GET', '/api/mcp/shares', undefined, { remote: true, peer: member }),
      {
        status: 403
      }
    )
    await assert.rejects(
      call(
        service,
        'POST',
        '/api/mcp/shares',
        {
          name: 'agent-write',
          enabled: true,
          transport: 'stdio',
          command: 'x'
        },
        { agent: true }
      ),
      { status: 403 }
    )
    assert.throws(() => service.checkForward({}, new URL('/api/m/B/mcp/shares', 'http://local')), {
      status: 403
    })
    assert.throws(
      () => service.checkForward({}, new URL('/api/m/B/api/mcp/shares/x/remove', 'http://local')),
      { status: 403 }
    )
    service.checkForward({}, new URL('/api/m/B/mcp/available', 'http://local'))
    await service.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
