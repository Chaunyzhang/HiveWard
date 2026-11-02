import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createOrganization } from './lan-organization.mjs'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function api(port, path = '/api/machines', body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  })
  return { status: response.status, data: await response.json() }
}
const log = (command, result) => console.log(`${command}\n${JSON.stringify(result)}`)

test(
  'three isolated bridges: discovery, consent, mesh, revocation, migration',
  { timeout: 90000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-lan-acceptance-'))
    const children = []
    const sockets = new Set()
    const rpcResults = {
      'repo.list': { repos: [] },
      'status.get': { appVersion: 'test', machineName: 'isolated-test-runtime' },
      'terminal.list': { terminals: [] },
      'worktree.list': { worktrees: [] },
      'orchestration.runList': { runs: [] },
      'orchestration.inbox': { messages: [] }
    }
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
          const result = rpcResults[request.method]
          socket.write(
            `${JSON.stringify({ id: request.id, ok: !!result, result, error: result ? undefined : { code: 'method_not_found', message: `Read-only test runtime: ${request.method}` } })}\n`
          )
        }
      })
    })
    const socketPath =
      process.platform === 'win32'
        ? String.raw`\\.\pipe\codex-lan-${process.pid}`
        : join(root, 'runtime.sock')
    runtime.listen(socketPath)
    await once(runtime, 'listening')
    await writeFile(
      join(root, 'runtime.json'),
      JSON.stringify({
        authToken: 'test-only',
        transports: [{ kind: 'unix', endpoint: socketPath }]
      })
    )
    async function start(name, port, legacy) {
      const dir = join(root, name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'businesses.json'), '[]')
      await writeFile(join(dir, 'machine.json'), JSON.stringify({ id: name, name: `Test ${name}` }))
      if (legacy) {
        await writeFile(join(dir, 'peers.json'), JSON.stringify(legacy))
      }
      const child = spawn(process.execPath, ['opc/server/tests/exit-region-bridge-fixture.mjs'], {
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          OPC_PORT: String(port),
          OPC_LAN_PORT: String(port + 1),
          OPC_DATA_DIR: dir,
          ORCA_RUNTIME_META: join(root, 'runtime.json')
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      children.push(child)
      let output = ''
      child.stdout.on('data', (d) => {
        output += d.toString()
      })
      child.stderr.on('data', (d) => {
        output += d.toString()
      })
      for (let n = 0; n < 100; n++) {
        if (child.exitCode !== null) {
          throw new Error(output)
        }
        if (output.includes('orca-bridge on')) {
          return dir
        }
        await pause(50)
      }
      throw new Error(`Startup timed out: ${output}`)
    }
    try {
      const aDir = await start('A', 18807)
      const bDir = await start('B', 18817)
      await start('C', 18827)
      let discovered = false
      for (let n = 0; n < 40; n++) {
        const a = await api(18807),
          b = await api(18817)
        if (
          a.data.machines.some((m) => m.id === 'B' && m.discovered) &&
          b.data.machines.some((m) => m.id === 'A' && m.discovered)
        ) {
          log('GET A /api/machines', a)
          log('GET B /api/machines', b)
          discovered = true
          break
        }
        await pause(250)
      }
      assert.ok(discovered, 'automatic discovery in both directions')
      const rejected = await api(18807, '/api/machines/invite', { address: '127.0.0.1:18818' })
      assert.equal(rejected.status, 200)
      log(
        'POST B reject',
        await api(18817, `/api/machines/invitations/${rejected.data.id}/reject`, {})
      )
      assert.equal((await api(18807)).data.invitations[0].status, 'rejected')
      assert.equal((await api(18818, '/api/overview')).status, 401)
      const cancelled = await api(18807, '/api/machines/invite', { address: '127.0.0.1:18818' })
      assert.equal(
        (await api(18807, `/api/machines/invitations/${cancelled.data.id}/cancel`, {})).status,
        200
      )
      assert.equal(
        (await api(18817, `/api/machines/invitations/${cancelled.data.id}/accept`, {})).status,
        409
      )
      const invite = await api(18807, '/api/machines/invite', { address: '127.0.0.1:18818' })
      log('POST A invite B', invite)
      log('GET B pending consent', await api(18817))
      assert.equal(
        (await api(18817)).data.invitations.find((i) => i.id === invite.data.id).status,
        'pending'
      )
      assert.equal((await api(18807, '/api/m/B/api/overview')).status, 404)
      log(
        'POST B accept',
        await api(18817, `/api/machines/invitations/${invite.data.id}/accept`, {})
      )
      for (const port of [18807, 18817]) {
        const r = await api(port)
        log(`GET ${port} /api/machines`, r)
        assert.equal(r.data.machines.filter((m) => m.paired).length, 2)
      }
      const overview = await api(18807, '/api/m/B/api/overview')
      log('GET A /api/m/B/api/overview', overview)
      assert.equal(overview.status, 200)
      const c = await api(18817, '/api/machines/invite', { address: '127.0.0.1:18828' })
      assert.equal(c.status, 200)
      assert.equal(
        (await api(18827, `/api/machines/invitations/${c.data.id}/accept`, {})).status,
        200
      )
      for (const [port, other] of [
        [18807, 'C'],
        [18817, 'C'],
        [18827, 'A'],
        [18827, 'B']
      ]) {
        const r = await api(port, `/api/m/${other}/api/overview`)
        log(`GET ${port} /api/m/${other}/api/overview`, r)
        assert.equal(r.status, 200)
      }
      const rename = await api(18827, '/api/machines/organization/rename', {
        name: 'Three computers'
      })
      assert.equal(rename.status, 200)
      assert.equal((await api(18807)).data.organization.name, 'Three computers')
      assert.equal((await api(18817)).data.organization.name, 'Three computers')
      log('POST C rename organization', rename)
      const staleA = JSON.parse(await readFile(join(aDir, 'peers.json'))).find(
        (p) => p.id === 'B'
      ).outboundToken
      const staleB = JSON.parse(await readFile(join(bDir, 'peers.json'))).find(
        (p) => p.id === 'A'
      ).outboundToken
      const removed = await api(18827, '/api/machines/B/remove', {})
      log('POST C remove B', removed)
      assert.equal(removed.data.pending, 0)
      const removalNotice = (await api(18817)).data.organizationNotices.at(-1)
      assert.equal(removalNotice.type, 'removed')
      assert.equal(removalNotice.actor.id, 'C')
      log('GET B removal notice', removalNotice)
      for (const [port, token] of [
        [18818, staleA],
        [18808, staleB]
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}/api/overview`, {
          headers: { authorization: `Bearer ${token}` }
        })
        log(`GET ${port} overview with revoked credential`, { status: response.status })
        assert.equal(response.status, 401)
      }
      assert.equal((await api(18807, '/api/m/B/api/overview')).status, 404)
      const leave = await api(18827, '/api/machines/organization/leave', {})
      log('POST C leave', leave)
      assert.equal(leave.data.pending, 0)
      assert.equal((await api(18827, '/api/m/A/api/overview')).status, 404)
      assert.equal((await api(18807, '/api/m/C/api/overview')).status, 404)
      const token1 = 'a'.repeat(64),
        token2 = 'b'.repeat(64)
      await start('legacy-A', 18837, [
        {
          id: 'legacy-B',
          name: 'Old B',
          address: '127.0.0.1:18848',
          inboundToken: token1,
          outboundToken: token2
        }
      ])
      await start('legacy-B', 18847, [
        {
          id: 'legacy-A',
          name: 'Old A',
          address: '127.0.0.1:18838',
          inboundToken: token2,
          outboundToken: token1
        }
      ])
      const oldA = await api(18837),
        oldB = await api(18847)
      log('GET migrated A /api/machines', oldA)
      log('GET migrated B /api/machines', oldB)
      assert.equal(oldA.data.organization.id, oldB.data.organization.id)
      assert.equal((await api(18837, '/api/m/legacy-B/api/overview')).status, 200)
      assert.equal((await api(18807, '/api/machines/pair-code', {})).status, 404)
      assert.equal((await api(18807, '/api/machines/pair', {})).status, 404)
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
      log('cleanup', { childrenStopped: children.length, removed: root })
    }
  }
)

test('expiry, flood limiting and invalid consent never grant credentials', async () => {
  let clock = 100000
  let members = []
  const org = createOrganization({
    machine: { id: 'B', name: 'B' },
    lanPort: 18818,
    read: (_file, fallback) => fallback(),
    save() {},
    file: 'unused',
    peers: () => members,
    replace: (next) => {
      members = next
    },
    remote: async () => {
      throw new Error('must not contact peer')
    },
    now: () => clock,
    ttl: 1000
  })
  const req = { socket: { remoteAddress: '127.0.0.1' } }
  const body = (n) => ({
    id: `inv-${n}`,
    machine: { id: 'A', name: 'A', user: 'tester', port: 18808 },
    organization: { id: 'org', name: 'Test' },
    capability: 'a'.repeat(64),
    expires: clock + 1000
  })
  try {
    await org.receive(req, '/lan/invitations', body(1))
    clock += 1001
    await assert.rejects(org.action('inv-1', 'accept'), { code: 'invite_expired' })
    log('advance injected clock; POST expired accept', {
      code: 'invite_expired',
      invitations: org.snapshot().invitations
    })
    for (let n = 2; n <= 5; n++) {
      await org.receive(req, '/lan/invitations', body(n))
    }
    await assert.rejects(org.receive(req, '/lan/invitations', body(6)), {
      status: 429,
      code: 'invite_rate_limited'
    })
    log('sixth invitation in 60 seconds', { status: 429, code: 'invite_rate_limited' })
    await assert.rejects(org.receive(req, '/lan/invitations/inv-2/cancel', { capability: 'bad' }), {
      status: 401
    })
    await assert.rejects(org.receive(req, '/lan/organization/member', { peer: {} }), {
      status: 401
    })
    assert.deepEqual(members, [])
  } finally {
    org.close()
  }
})

test('UDP fallback discovers peers without Bonjour', { timeout: 10000 }, async () => {
  const { discoverUdp } = await import('./lan-discovery.mjs')
  const seenA = new Set(),
    seenB = new Set()
  const stopA = discoverUdp(
    { id: 'udp-test-A', name: 'UDP A' },
    18858,
    (d) => seenA.add(d.id),
    () => {}
  )
  const stopB = discoverUdp(
    { id: 'udp-test-B', name: 'UDP B' },
    18868,
    (d) => seenB.add(d.id),
    () => {}
  )
  try {
    for (let n = 0; n < 30 && (!seenA.has('udp-test-B') || !seenB.has('udp-test-A')); n++) {
      await pause(200)
    }
    assert.ok(seenA.has('udp-test-B'))
    assert.ok(seenB.has('udp-test-A'))
    log('UDP-only discovery (no dns-sd)', { aFoundB: true, bFoundA: true })
  } finally {
    stopA()
    stopB()
  }
})

test('offline membership and removal deliveries survive restart', { timeout: 8000 }, async () => {
  let stored = { organization: { id: 'org', name: 'Studio' }, deliveries: [] }
  let members = [
    {
      id: 'B',
      name: 'B',
      address: '127.0.0.1:18818',
      inboundToken: 'b'.repeat(64),
      outboundToken: 'a'.repeat(64)
    }
  ]
  let online = false
  let invitation
  const delivered = []
  const options = {
    machine: { id: 'A', name: 'A' },
    lanPort: 18808,
    read: () => structuredClone(stored),
    save: (_file, value) => {
      stored = structuredClone(value)
    },
    file: 'unused',
    peers: () => members,
    replace: (next) => {
      members = next
    },
    remote: async (_address, path, options) => {
      if (path === '/lan/hello') {
        return { id: 'C', name: 'C' }
      }
      if (path === '/lan/invitations') {
        invitation = options.body
        return {}
      }
      if (!online) {
        throw new Error('offline')
      }
      delivered.push(path)
      return { ok: true }
    }
  }
  let org = createOrganization(options)
  try {
    const invite = await org.invite('127.0.0.1:18828')
    await org.receive({ headers: {} }, `/lan/invitations/${invite.id}/decision`, {
      capability: invitation.capability,
      accept: true,
      token: 'c'.repeat(64)
    })
    assert.equal(org.snapshot().pendingMembers, 1)
    org.close()
    online = true
    org = createOrganization(options)
    for (let n = 0; n < 30 && org.snapshot().pendingMembers; n++) {
      await pause(100)
    }
    assert.equal(org.snapshot().pendingMembers, 0)
    assert.ok(delivered.includes('/lan/organization/member'))
    online = false
    assert.equal((await org.remove('B')).pending, 2)
    assert.ok(!members.some((p) => p.id === 'B'))
    org.close()
    online = true
    org = createOrganization(options)
    for (let n = 0; n < 30 && org.snapshot().pendingRemovals; n++) {
      await pause(100)
    }
    assert.equal(org.snapshot().pendingRemovals, 0)
    log('restart with persisted offline deliveries', {
      memberRetry: 'passed',
      removalRetry: 'passed'
    })
  } finally {
    org.close()
  }
})
