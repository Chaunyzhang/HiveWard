/* eslint-disable max-lines */
import { createHash } from 'node:crypto'
import { tlsJson } from './lan-tls.mjs'
import { nonceCommitment } from './lan-invitation-verification.mjs'
import { loadLanCertificate } from './lan-certificate.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createOrganization } from './lan-organization.mjs'

const fingerprint = (id) => createHash('sha256').update(id).digest('hex')
const socketFor = (id) => ({
  encrypted: true,
  remoteAddress: '127.0.0.1',
  getPeerCertificate: () => ({ raw: Buffer.from(id) })
})
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function api(port, path = '/api/machines', body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  })
  return { status: response.status, data: await response.json() }
}
const log = (command, result) => console.log(`${command}\n${JSON.stringify(result)}`)
function cli(port, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['hiveward/server/hiwd.mjs', ...args], {
      env: {
        ...process.env,
        HIVEWARD_BRIDGE: `http://127.0.0.1:${port}`,
        HIVEWARD_BACKGROUND_LAUNCH: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (data) => (stdout += data))
    child.stderr.on('data', (data) => (stderr += data))
    child.on('error', reject)
    child.on('close', (code) => {
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() }
      log(
        `HIVEWARD_BRIDGE=http://127.0.0.1:${port} node hiveward/server/hiwd.mjs ${args.join(' ')}`,
        result
      )
      resolve(result)
    })
  })
}
const testPeer = (id, port) => ({
  id,
  name: id,
  address: `127.0.0.1:${port}`,
  fingerprint: fingerprint(id),
  tlsPort: port + 1,
  inboundToken: createHash('sha256').update(`${id}-in`).digest('hex'),
  outboundToken: createHash('sha256').update(`${id}-out`).digest('hex')
})

function organizationNetwork(now = Date.now, ttl) {
  const network = { nodes: new Map(), requests: [], dropNextDecision: false }
  network.add = (id, initialPeers = []) => {
    const port = 19008 + network.nodes.size * 10
    const node = {
      machine: { id, name: id },
      address: `127.0.0.1:${port}`,
      port,
      members: initialPeers,
      stored: undefined
    }
    node.org = createOrganization({
      machine: node.machine,
      lanPort: port,
      identity: () => ({ fingerprint: fingerprint(id), tlsPort: port + 1 }),
      read: (_file, fallback) => node.stored ?? fallback(),
      save: (_file, value) => {
        node.stored = structuredClone(value)
      },
      file: 'unused',
      now,
      ttl,
      peers: () => node.members,
      replace: (next) => {
        node.members = next
      },
      remote: async (address, path, options = {}) => {
        network.requests.push({ from: id, address, path, body: options.body })
        if (path.endsWith('/decision') && network.dropNextDecision) {
          network.dropNextDecision = false
          throw new Error('decision response lost')
        }
        const target = [...network.nodes.values()].find((item) => item.address === address)
        if (!target) {
          throw new Error('offline')
        }
        if (path === '/lan/hello') {
          return {
            ...target.machine,
            fingerprint: fingerprint(target.machine.id),
            tlsPort: target.port + 1,
            organization: target.org.summary()
          }
        }
        const authenticated = target.members.find(
          (p) => p.id === id && p.inboundToken === options.token
        )
        const payload = structuredClone(options.body)
        if (network.legacy && payload) {
          delete payload.verificationProtocol
        }
        const reply = await target.org.receive(
          {
            socket: socketFor(id),
            headers: { authorization: options.token ? `Bearer ${options.token}` : '' }
          },
          path,
          payload,
          authenticated
        )
        if (network.legacy && reply) {
          delete reply.verificationProtocol
        }
        return reply
      }
    })
    network.nodes.set(id, node)
    return node
  }
  network.close = () => {
    for (const node of network.nodes.values()) {
      node.org.close()
    }
  }
  return network
}

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
      const child = spawn(
        process.execPath,
        ['hiveward/server/tests/exit-region-bridge-fixture.mjs'],
        {
          env: {
            ...process.env,
            HIVEWARD_BACKGROUND_LAUNCH: '1',
            HIVEWARD_PORT: String(port),
            HIVEWARD_LAN_PORT: String(port + 1),
            HIVEWARD_DISCOVERY_PORT: '28889',
            HIVEWARD_DATA_DIR: dir,
            HIVEWARD_RUNTIME_META: join(root, 'runtime.json')
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        }
      )
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
        if (output.includes('bridge on')) {
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
      const initialA = await api(18807)
      const initialB = await api(18817)
      for (const [snapshot, id] of [
        [initialA.data, 'A'],
        [initialB.data, 'B']
      ]) {
        assert.equal(snapshot.organization.name, `Test ${id}的组织`)
        assert.deepEqual(snapshot.organization.members, [id])
        assert.equal(snapshot.pendingMembers, 0)
        assert.equal(snapshot.pendingRemovals, 0)
        assert.equal(snapshot.pendingOrganizationUpdates, 0)
        assert.deepEqual(snapshot.machines.find((m) => m.id === id).organization, {
          id: snapshot.organization.id,
          name: snapshot.organization.name,
          members: 1
        })
      }
      const discoveredB = initialA.data.machines.find((m) => m.id === 'B')
      const discoveredA = initialB.data.machines.find((m) => m.id === 'A')
      assert.equal(discoveredB.organization.name, 'Test B的组织')
      assert.equal(discoveredB.organization.members, 1)
      assert.equal(discoveredA.organization.name, 'Test A的组织')
      assert.equal(discoveredA.organization.members, 1)
      log('default organizations and public discovery summaries', {
        a: initialA.data.organization,
        b: initialB.data.organization,
        discoveredA: discoveredA.organization,
        discoveredB: discoveredB.organization,
        pending: [
          initialA.data.pendingMembers,
          initialA.data.pendingRemovals,
          initialA.data.pendingOrganizationUpdates
        ]
      })
      const rejected = await api(18807, '/api/machines/invite', { address: '127.0.0.1:18818' })
      assert.equal(rejected.status, 200)
      log(
        'POST B reject',
        await api(18817, `/api/machines/invitations/${rejected.data.id}/reject`, {})
      )
      assert.equal((await api(18807)).data.invitations[0].status, 'rejected')
      assert.equal((await api(18818, '/api/overview')).status, 403)
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
        assert.equal(response.status, 403)
      }
      const bHello = await (await fetch('http://127.0.0.1:18818/lan/hello')).json()
      await assert.rejects(
        tlsJson(
          loadLanCertificate(aDir),
          { address: '127.0.0.1:18818', ...bHello },
          '/api/overview',
          { token: staleA }
        ),
        { status: 401 }
      )
      assert.equal((await api(18807, '/api/m/B/api/overview')).status, 404)
      const removedDefault = (await api(18817)).data
      assert.equal(removedDefault.organization.name, 'Test B的组织')
      assert.deepEqual(removedDefault.organization.members, ['B'])
      assert.notEqual(removedDefault.organization.id, invite.data.organization.id)
      log('B recreates default organization after removal', removedDefault.organization)

      const selfProxyJoin = await api(18817, '/api/m/B/api/machines/join', { machineId: 'A' })
      const agentJoin = await api(
        18817,
        '/api/machines/join',
        { machineId: 'A' },
        { 'x-hiveward-caller': 'agent' }
      )
      assert.equal(selfProxyJoin.status, 403)
      assert.equal(agentJoin.status, 403)
      assert.equal(
        (await api(18817)).data.invitations.filter((i) => i.kind === 'request').length,
        0
      )
      log('POST join through /api/m/ and as Agent', { selfProxyJoin, agentJoin })

      const aHello = await (await fetch('http://127.0.0.1:18808/lan/hello')).json()
      const unauthorized = await tlsJson(
        loadLanCertificate(bDir),
        { address: '127.0.0.1:18808', ...aHello },
        '/api/overview'
      ).then(
        () => ({ status: 200 }),
        (cause) => ({ status: cause.status, code: cause.code })
      )
      assert.equal(unauthorized.status, 401)
      log('B calls protected A API before consent', unauthorized)

      const rejectedRequest = await api(18817, '/api/machines/join', { machineId: 'A' })
      assert.equal(rejectedRequest.status, 200)
      assert.equal(rejectedRequest.data.kind, 'request')
      assert.equal(rejectedRequest.data.direction, 'sent')
      const rejectedIncoming = (await api(18807)).data.invitations.find(
        (i) => i.id === rejectedRequest.data.id
      )
      assert.equal(rejectedIncoming.direction, 'incoming')
      assert.equal(rejectedIncoming.verifyCode, rejectedRequest.data.verifyCode)
      assert.equal(
        (await api(18807, `/api/machines/invitations/${rejectedRequest.data.id}/reject`, {}))
          .status,
        200
      )
      assert.equal(
        (await api(18817)).data.invitations.find((i) => i.id === rejectedRequest.data.id).status,
        'rejected'
      )
      log('request join rejected by organization side', {
        a: (await api(18807)).data.invitations.find((i) => i.id === rejectedRequest.data.id),
        b: (await api(18817)).data.invitations.find((i) => i.id === rejectedRequest.data.id)
      })

      const cancelledRequest = await api(18817, '/api/machines/join', { machineId: 'A' })
      assert.equal(
        (await api(18817, `/api/machines/invitations/${cancelledRequest.data.id}/cancel`, {}))
          .status,
        200
      )
      const acceptCancelled = await api(
        18807,
        `/api/machines/invitations/${cancelledRequest.data.id}/accept`,
        {}
      )
      assert.equal(acceptCancelled.status, 409)
      log('B withdraws request; A accept afterwards', acceptCancelled)

      const oldBDefault = (await api(18817)).data.organization.id
      for (let n = 0; n < 30; n++) {
        const current = await api(18817)
        if (
          current.data.machines.find((m) => m.id === 'A')?.organization?.name === 'Three computers'
        ) {
          break
        }
        await pause(200)
      }
      const machineList = await cli(18817, ['machines'])
      assert.equal(machineList.code, 0)
      assert.match(machineList.stdout, /组织 Three computers/)
      const joined = await cli(18817, ['machines', 'join', 'Test A'])
      assert.equal(joined.code, 0)
      const request = JSON.parse(joined.stdout)
      const incoming = (await api(18807)).data.invitations.find((i) => i.id === request.id)
      assert.equal(request.kind, 'request')
      assert.equal(request.direction, 'sent')
      assert.equal(incoming.kind, 'request')
      assert.equal(incoming.direction, 'incoming')
      assert.equal(incoming.verifyCode, request.verifyCode)
      log('request join verification codes', {
        a: { kind: incoming.kind, direction: incoming.direction, verifyCode: incoming.verifyCode },
        b: { kind: request.kind, direction: request.direction, verifyCode: request.verifyCode }
      })
      assert.equal((await api(18817, '/api/machines/join', { machineId: 'A' })).data.id, request.id)
      assert.equal(
        (await api(18807, `/api/machines/invitations/${request.id}/accept`, {})).status,
        200
      )
      for (const port of [18807, 18817, 18827]) {
        const current = (await api(port)).data
        assert.equal(current.organization.id, request.organization.id)
        assert.equal(current.organization.members.length, 3)
      }
      for (const port of [18807, 18817]) {
        const current = (await api(port)).data
        assert.equal(current.invitations.find((i) => i.id === request.id).status, 'accepted')
      }
      assert.notEqual((await api(18817)).data.organization.id, oldBDefault)
      log('request join accepted organizations', {
        oldBDefault,
        a: (await api(18807)).data.organization,
        b: (await api(18817)).data.organization,
        c: (await api(18827)).data.organization
      })
      for (const [port, other] of [
        [18807, 'B'],
        [18817, 'A'],
        [18817, 'C'],
        [18827, 'B']
      ]) {
        const response = await api(port, `/api/m/${other}/api/overview`)
        log(`GET ${port} /api/m/${other}/api/overview after request join`, response)
        assert.equal(response.status, 200)
      }
      const sameOrganization = await api(18817, '/api/machines/join', { machineId: 'A' })
      assert.equal(sameOrganization.status, 409)
      log('request join accepted; same organization retry', sameOrganization)

      const leave = await api(18827, '/api/machines/organization/leave', {})
      log('POST C leave', leave)
      assert.equal(leave.data.pending, 0)
      const leftDefault = (await api(18827)).data
      assert.equal(leftDefault.organization.name, 'Test C的组织')
      assert.deepEqual(leftDefault.organization.members, ['C'])
      assert.equal(leftDefault.pendingMembers, 0)
      assert.equal(leftDefault.pendingOrganizationUpdates, 0)
      log('C recreates default organization after leave', leftDefault.organization)
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
      assert.equal(oldA.data.organization.name, 'Test legacy-A的组织')
      assert.equal(oldB.data.organization.name, 'Test legacy-B的组织')
      assert.deepEqual(oldA.data.organization.members, ['legacy-A'])
      assert.deepEqual(oldB.data.organization.members, ['legacy-B'])
      assert.equal(oldA.data.machines.find((m) => m.id === 'legacy-B').secure, false)
      assert.equal(
        (await api(18837, '/api/m/legacy-B/api/overview')).data.error.code,
        'tls_rejoin_required'
      )
      await api(18837, '/api/machines/legacy-B/remove', {})
      await api(18847, '/api/machines/legacy-A/remove', {})
      const rejoin = await api(18837, '/api/machines/invite', { address: '127.0.0.1:18848' })
      assert.equal(rejoin.status, 200)
      assert.equal(
        (await api(18847, `/api/machines/invitations/${rejoin.data.id}/accept`, {})).status,
        200
      )
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
  const req = { socket: socketFor('A') }
  const body = (n) => ({
    id: `inv-${n}`,
    machine: { id: 'A', name: 'A', user: 'tester', port: 18808, tlsPort: 18809 },
    commitment: nonceCommitment('d'.repeat(64)),
    organization: { id: 'org', name: 'Test' },
    capability: 'a'.repeat(64),
    expires: clock + 1000
  })
  try {
    await org.receive(req, '/lan/invitations', body(1))
    await assert.rejects(
      org.receive(req, '/lan/invitations/inv-1/verify', {
        capability: 'a'.repeat(64),
        nonce: 'e'.repeat(64)
      }),
      { code: 'invalid_commitment' }
    )

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

test('default organization excludes legacy peers and recreates after leave and removal', async () => {
  let members = [{ id: 'legacy', name: 'Legacy', address: '127.0.0.1:19000' }]
  const org = createOrganization({
    machine: { id: 'A', name: 'Alice' },
    lanPort: 19008,
    identity: () => ({ fingerprint: fingerprint('A'), tlsPort: 19009 }),
    read: (_file, fallback) => fallback(),
    save() {},
    file: 'unused',
    peers: () => members,
    replace: (next) => {
      members = next
    },
    remote: async () => {
      throw new Error('offline')
    }
  })
  try {
    const initial = org.snapshot().organization
    assert.equal(initial.name, 'Alice的组织')
    assert.deepEqual(initial.members, ['A'])
    assert.deepEqual(org.summary(), { id: initial.id, name: initial.name, members: 1 })
    assert.equal(org.snapshot().pendingMembers, 0)
    assert.equal(org.snapshot().pendingRemovals, 0)
    assert.equal(org.snapshot().pendingOrganizationUpdates, 0)

    await org.remove('A')
    const afterLeave = org.snapshot().organization
    assert.notEqual(afterLeave.id, initial.id)
    assert.deepEqual(afterLeave.members, ['A'])

    members = [testPeer('B', 19108)]
    await org.receive(
      { socket: socketFor('B'), headers: {} },
      '/lan/organization/remove',
      { id: 'A', organizationId: afterLeave.id },
      { id: 'B', name: 'B' }
    )
    const afterRemoval = org.snapshot().organization
    assert.notEqual(afterRemoval.id, afterLeave.id)
    assert.deepEqual(afterRemoval.members, ['A'])
    assert.equal(org.snapshot().organizationNotices.at(-1).type, 'removed')
  } finally {
    org.close()
  }
})

test('default organizations accept ordinary invites and deduplicate local requests', async () => {
  const network = organizationNetwork()
  const a = network.add('A')
  const b = network.add('B')
  try {
    const invite = await a.org.invite(b.address)
    const incoming = b.org.snapshot().invitations.find((i) => i.id === invite.id)
    assert.equal(invite.kind, 'invite')
    assert.equal(incoming.kind, 'invite')
    assert.equal(incoming.verifyCode, invite.verifyCode)
    assert.equal((await a.org.invite(b.address)).id, invite.id)
    assert.equal((await b.org.requestJoin(a.address)).id, incoming.id)

    await b.org.action(incoming.id, 'accept')
    assert.equal(a.org.snapshot().organization.id, b.org.snapshot().organization.id)
    assert.equal(a.org.summary().members, 2)
    assert.equal(b.org.summary().members, 2)
    await assert.rejects(b.org.requestJoin(a.address), { code: 'already_in_organization' })

    const joinedId = b.org.summary().id
    assert.equal((await b.org.remove('B')).pending, 0)
    assert.notEqual(b.org.summary().id, joinedId)
    assert.deepEqual(b.org.summary(), {
      id: b.org.summary().id,
      name: 'B的组织',
      members: 1
    })
    assert.equal(b.org.snapshot().pendingRemovals, 0)
  } finally {
    network.close()
  }
})

test('request join accepts without joiner consent, retries and preserves offline removals', async () => {
  const network = organizationNetwork()
  const a = network.add('A', [testPeer('C', 19208)])
  const b = network.add('B', [testPeer('D', 19218)])
  try {
    const oldOrganizationId = b.org.summary().id
    const request = await b.org.requestJoin(a.address)
    const incoming = a.org.snapshot().invitations.find((i) => i.id === request.id)
    assert.equal(request.kind, 'request')
    assert.equal(request.direction, 'sent')
    assert.equal(incoming.kind, 'request')
    assert.equal(incoming.direction, 'incoming')
    assert.equal(incoming.verifyCode, request.verifyCode)
    assert.equal((await b.org.requestJoin(a.address)).id, request.id)

    network.dropNextDecision = true
    await assert.rejects(a.org.action(request.id, 'accept'), /decision response lost/)
    assert.equal(a.org.snapshot().invitations.find((i) => i.id === request.id).status, 'accepted')
    assert.equal(b.org.snapshot().invitations.find((i) => i.id === request.id).status, 'pending')
    assert.equal(a.org.snapshot().pendingMembers, 1)

    await a.org.action(request.id, 'accept')
    assert.equal(b.org.snapshot().invitations.find((i) => i.id === request.id).status, 'accepted')
    assert.equal(a.org.summary().id, b.org.summary().id)
    assert.notEqual(b.org.summary().id, oldOrganizationId)
    assert.equal(a.org.summary().members, 3)
    assert.equal(b.org.summary().members, 3)
    assert.ok(!b.members.some((p) => p.id === 'D'))
    assert.equal(a.org.snapshot().pendingMembers, 1)
    assert.equal(b.org.snapshot().pendingRemovals, 1)

    const joinBody = network.requests.find(
      (r) => r.from === 'B' && r.path === '/lan/invitations' && r.body.id === request.id
    ).body
    const aSide = a.members.find((p) => p.id === 'B')
    const bSide = b.members.find((p) => p.id === 'A')
    assert.equal(aSide.outboundToken, joinBody.token)
    assert.equal(bSide.inboundToken, joinBody.token)
    assert.equal(aSide.inboundToken, bSide.outboundToken)

    await a.org.action(request.id, 'accept')
    assert.equal(a.org.snapshot().pendingMembers, 1)
    assert.equal(b.org.snapshot().pendingRemovals, 1)
  } finally {
    network.close()
  }
})

test('request join rejection and cancellation stay on the organization side', async () => {
  const network = organizationNetwork()
  const a = network.add('A')
  const b = network.add('B')
  try {
    const rejected = await b.org.requestJoin(a.address)
    await a.org.action(rejected.id, 'reject')
    assert.equal(a.org.snapshot().invitations.find((i) => i.id === rejected.id).status, 'rejected')
    assert.equal(b.org.snapshot().invitations.find((i) => i.id === rejected.id).status, 'rejected')
    assert.deepEqual(a.members, [])
    assert.deepEqual(b.members, [])

    const cancelled = await b.org.requestJoin(a.address)
    await b.org.action(cancelled.id, 'cancel')
    assert.equal(
      a.org.snapshot().invitations.find((i) => i.id === cancelled.id).status,
      'cancelled'
    )
    await assert.rejects(a.org.action(cancelled.id, 'accept'), { code: 'invite_cancelled' })
  } finally {
    network.close()
  }
})

test('request join expires without granting membership', async () => {
  let clock = 100000
  const network = organizationNetwork(() => clock, 1000)
  const a = network.add('A')
  const b = network.add('B')
  try {
    const request = await b.org.requestJoin(a.address)
    clock += 1001
    await assert.rejects(a.org.action(request.id, 'accept'), { code: 'invite_expired' })
    assert.equal(a.org.snapshot().invitations.find((i) => i.id === request.id).status, 'expired')
    assert.equal(b.org.snapshot().invitations.find((i) => i.id === request.id).status, 'expired')
    assert.deepEqual(a.members, [])
    assert.deepEqual(b.members, [])
    log('request join expiry', { status: 'expired', members: 0 })
  } finally {
    network.close()
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
    () => {},
    { discoveryPort: 28889 }
  )
  const stopB = discoverUdp(
    { id: 'udp-test-B', name: 'UDP B' },
    18868,
    (d) => seenB.add(d.id),
    () => {},
    { discoveryPort: 28889 }
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
      fingerprint: fingerprint('B'),
      tlsPort: 18819,
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
    identity: () => ({ fingerprint: fingerprint('A'), tlsPort: 18809 }),
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
        return { id: 'C', name: 'C', fingerprint: fingerprint('C'), tlsPort: 18829 }
      }
      if (path === '/lan/invitations') {
        invitation = options.body
        return { nonce: 'e'.repeat(64) }
      }
      if (path.endsWith('/verify')) {
        return { ok: true }
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
    await org.receive(
      { headers: {}, socket: socketFor('C') },
      `/lan/invitations/${invite.id}/decision`,
      {
        capability: invitation.capability,
        accept: true,
        token: 'c'.repeat(64)
      }
    )
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

test('旧版不支持算法协商时，邀请两端仍得到相同确认码并可接受', async () => {
  const network = organizationNetwork()
  network.legacy = true
  const a = network.add('A')
  const b = network.add('B')
  try {
    const invite = await a.org.invite(b.address)
    const incoming = b.org.snapshot().invitations.find((i) => i.id === invite.id)
    assert.match(invite.verifyCode, /^\d{6}$/)
    assert.equal(incoming.verifyCode, invite.verifyCode)
    await b.org.action(incoming.id, 'accept')
    assert.equal(a.org.snapshot().organization.id, b.org.snapshot().organization.id)
  } finally {
    network.close()
  }
})
