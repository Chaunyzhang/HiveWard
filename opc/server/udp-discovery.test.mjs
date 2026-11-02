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

test('UDP sockets discover Mac/Windows, carry only public metadata, expire and close twice safely', async (t) => {
  const reservation = createSocket('udp4')
  await new Promise((resolve) => reservation.bind(0, resolve))
  const discoveryPort = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const a = new Map(),
    b = new Map()
  const options = { discoveryPort, interval: 100, ttl: 350, version: '1.2.3' }
  const stopA = discoverUdp(
    { id: 'mac-test', name: 'Mac test', platform: 'darwin', token: 'must-not-leak' },
    19881,
    (m) => a.set(m.id, m),
    (id) => a.delete(id),
    options
  )
  const stopB = discoverUdp(
    { id: 'windows-test', name: 'Windows test', platform: 'win32' },
    19882,
    (m) => b.set(m.id, m),
    (id) => b.delete(id),
    options
  )
  t.after(() => {
    stopA()
    stopB()
  })
  await until(() => a.has('windows-test') && b.has('mac-test'))
  assert.equal(a.get('windows-test').platform, 'win32')
  assert.equal(b.get('mac-test').version, '1.2.3')
  assert.deepEqual(Object.keys(b.get('mac-test')).sort(), [
    'address',
    'id',
    'lastSeenAt',
    'name',
    'platform',
    'version'
  ])
  stopB()
  stopB()
  await until(() => !a.has('windows-test'))
  console.log('UDP Mac <-> simulated Windows: metadata OK; expired after close; no subprocesses')
})
