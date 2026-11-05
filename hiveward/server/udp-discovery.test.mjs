import test from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { discoverUdp } from './lan-discovery.mjs'

async function until(check, timeout = 5000) {
  const end = Date.now() + timeout
  while (!check()) {
    assert.ok(Date.now() < end, 'discovery timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function availablePort() {
  const reservation = createSocket('udp4')
  await new Promise((resolve) => reservation.bind(0, resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  return port
}

test('UDP sockets carry current public organizations, support legacy peers, expire and close safely', async (t) => {
  const discoveryPort = await availablePort()
  const servicePortA = await availablePort()
  const servicePortB = await availablePort()
  const broadcasts = []
  const capture = createSocket({ type: 'udp4', reuseAddr: true })
  capture.on('message', (buffer) => {
    try {
      const packet = JSON.parse(buffer.toString())
      if (packet.id === 'mac-test') {
        broadcasts.push(packet)
      }
    } catch {}
  })
  await new Promise((resolve) => capture.bind(discoveryPort, resolve))
  const a = new Map(),
    b = new Map()
  let organization = {
    id: 'org=mac',
    name: 'Mac 组织 = 一',
    members: 1,
    memberIds: ['mac-test'],
    token: 'org-token-must-not-leak',
    capability: 'org-capability-must-not-leak'
  }
  const options = { discoveryPort, interval: 100, ttl: 350, version: '1.2.3' }
  const stopA = discoverUdp(
    {
      id: 'mac-test',
      name: 'Mac test',
      platform: 'darwin',
      token: 'machine-token-must-not-leak',
      capability: 'machine-capability-must-not-leak'
    },
    servicePortA,
    (m) => a.set(m.id, m),
    (id) => a.delete(id),
    { ...options, organization: () => organization }
  )
  const stopB = discoverUdp(
    { id: 'windows-test', name: 'Windows test', platform: 'win32' },
    servicePortB,
    (m) => b.set(m.id, m),
    (id) => b.delete(id),
    options
  )
  t.after(() => {
    stopA()
    stopB()
    capture.close()
  })
  await until(() => a.has('windows-test') && b.has('mac-test'))
  assert.equal(a.get('windows-test').platform, 'win32')
  assert.equal(a.get('windows-test').organization, undefined)
  assert.equal(b.get('mac-test').version, '1.2.3')
  assert.deepEqual(b.get('mac-test').organization, {
    id: 'org=mac',
    name: 'Mac 组织 = 一',
    members: 1
  })
  assert.deepEqual(Object.keys(b.get('mac-test')).sort(), [
    'address',
    'id',
    'lastSeenAt',
    'name',
    'organization',
    'platform',
    'version'
  ])
  assert.deepEqual(Object.keys(b.get('mac-test').organization).sort(), ['id', 'members', 'name'])

  organization = { ...organization, name: '新 名称 = 二', members: 2 }
  await until(
    () =>
      b.get('mac-test')?.organization?.name === '新 名称 = 二' &&
      b.get('mac-test')?.organization?.members === 2 &&
      broadcasts.some(
        (packet) =>
          packet.organization?.name === '新 名称 = 二' && packet.organization?.members === 2
      )
  )
  const packet = broadcasts.findLast((packet) => packet.organization?.name === '新 名称 = 二')
  assert.deepEqual(packet.organization, { id: 'org=mac', name: '新 名称 = 二', members: 2 })
  assert.deepEqual(Object.keys(packet).sort(), [
    'id',
    'name',
    'organization',
    'platform',
    'port',
    'protocol',
    'version'
  ])
  assert.deepEqual(Object.keys(packet.organization).sort(), ['id', 'members', 'name'])
  console.log('UDP public broadcast:', JSON.stringify(packet))

  stopB()
  stopB()
  await until(() => !a.has('windows-test'))
})

test('UDP accepts machine organizations and legacy packets but rejects invalid public summaries', async (t) => {
  const discoveryPort = await availablePort()
  const sourcePort = await availablePort()
  const legacyPort = await availablePort()
  const found = new Map()
  const options = { discoveryPort, interval: 100, ttl: 1000, version: '1.2.3' }
  const sourceMachine = {
    id: 'machine-org-source',
    name: 'Machine organization source',
    organization: {
      id: 'org-machine',
      name: 'Machine org',
      members: ['machine-org-source'],
      token: 'org-token-must-not-leak'
    }
  }
  const stopSource = discoverUdp(
    sourceMachine,
    sourcePort,
    () => {},
    () => {},
    options
  )
  const stopSink = discoverUdp(
    { id: 'udp-sink', name: 'UDP sink' },
    await availablePort(),
    (machine) => found.set(machine.id, machine),
    (id) => found.delete(id),
    options
  )
  const sender = createSocket('udp4')
  t.after(() => {
    stopSource()
    stopSink()
    try {
      sender.close()
    } catch {}
  })
  await until(() => found.has('machine-org-source'))
  assert.deepEqual(found.get('machine-org-source').organization, {
    id: 'org-machine',
    name: 'Machine org',
    members: 1
  })
  assert.deepEqual(Object.keys(found.get('machine-org-source').organization).sort(), [
    'id',
    'members',
    'name'
  ])
  sourceMachine.organization = {
    id: 'org-machine',
    name: 'Machine org renamed',
    members: ['machine-org-source', 'other']
  }
  await until(() => found.get('machine-org-source')?.organization?.members === 2)
  assert.deepEqual(found.get('machine-org-source').organization, {
    id: 'org-machine',
    name: 'Machine org renamed',
    members: 2
  })

  const send = (packet) =>
    new Promise((resolve, reject) => {
      sender.send(Buffer.from(JSON.stringify(packet)), discoveryPort, '239.255.87.88', (error) =>
        error ? reject(error) : resolve()
      )
    })
  const base = {
    protocol: 'hiveward-discovery-1',
    name: 'Organization test peer',
    port: legacyPort,
    version: '1.2.3'
  }
  for (const [id, organization] of [
    ['bad-org-null', null],
    ['bad-org-id', { id: '', name: 'Valid', members: 1 }],
    ['bad-org-name', { id: 'org', name: ' ', members: 1 }],
    ['bad-org-long-name', { id: 'org', name: 'x'.repeat(201), members: 1 }],
    ['bad-org-zero', { id: 'org', name: 'Valid', members: 0 }],
    ['bad-org-fraction', { id: 'org', name: 'Valid', members: 1.5 }],
    ['bad-org-list', { id: 'org', name: 'Valid', members: ['peer'] }]
  ]) {
    await send({ ...base, id, organization })
  }
  await send({ ...base, id: 'legacy-peer' })
  await until(() => found.has('legacy-peer'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(found.get('legacy-peer').organization, undefined)
  assert.deepEqual(Object.keys(found.get('legacy-peer')).sort(), [
    'address',
    'id',
    'lastSeenAt',
    'name',
    'platform',
    'version'
  ])
  for (const id of [
    'bad-org-null',
    'bad-org-id',
    'bad-org-name',
    'bad-org-long-name',
    'bad-org-zero',
    'bad-org-fraction',
    'bad-org-list'
  ]) {
    assert.equal(found.has(id), false, id)
  }
})

test('broadcasts on every real LAN subnet, skipping loopback, link-local and point-to-point', async () => {
  const { lanBroadcastAddresses } = await import('./lan-discovery.mjs')
  const entry = (address, netmask, extra = {}) => ({
    family: 'IPv4',
    address,
    netmask,
    internal: false,
    ...extra
  })
  assert.deepEqual(
    lanBroadcastAddresses({
      lo0: [entry('127.0.0.1', '255.0.0.0', { internal: true })],
      en0: [
        entry('192.168.3.80', '255.255.255.0'),
        { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false }
      ],
      wifi: [entry('10.1.2.3', '255.255.240.0')],
      vEthernet: [entry('169.254.10.2', '255.255.0.0')],
      utun: [entry('198.18.0.1', '255.255.255.255')],
      clashTun: [entry('198.19.0.2', '255.255.255.252')],
      dup: [entry('192.168.3.81', '255.255.255.0')]
    }),
    ['192.168.3.255', '10.1.15.255']
  )
})

test('reports how the last announce round went', async (t) => {
  const discoveryPort = await availablePort()
  const stop = discoverUdp(
    { id: 'status-test', name: 'Status', platform: 'darwin' },
    9,
    () => {},
    () => {},
    {
      discoveryPort,
      interval: 50
    }
  )
  t.after(stop)
  await until(() => stop.status().lastAnnounceAt)
  const status = stop.status()
  assert.equal(status.listening, true)
  assert.equal(status.bindError, null)
  assert.ok(status.delivered + status.failed >= 2)
  assert.equal(typeof status.blocked, 'boolean')
})
