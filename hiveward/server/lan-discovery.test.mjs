import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess, runProcess } from '@hiveward/process-host'
import { createDiscoveryPresence } from './discovery-presence.mjs'
import { discoverBonjour } from './lan-discovery.mjs'
import {
  cleanupBonjourOrphans,
  ownedOrphan,
  legacyRegistrationPid,
  spawnBonjour
} from './bonjour-process.mjs'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) {
      return
    }
    await pause(20)
  }
  assert.fail('Condition timed out')
}

test('discovery requires matching hello, rechecks failures, expires without Rmv, ignores stale replies', async () => {
  let time = 0,
    hello = { id: 'peer', name: 'confirmed' },
    fail = false
  const visible = new Map()
  const presence = createDiscoveryPresence({
    now: () => time,
    interval: 5000,
    ttl: 10000,
    probe: async () => {
      if (fail) {
        throw new Error('offline')
      }
      return hello
    },
    found: (v) => visible.set(v.id, v),
    removed: (id) => visible.delete(id)
  })
  const candidate = { id: 'peer', name: 'untrusted', address: '127.0.0.1:18898' }
  try {
    hello.id = 'wrong'
    await presence.found(candidate)
    assert.equal(visible.size, 0)
    hello.id = 'peer'
    await presence.found(candidate)
    assert.equal(visible.get('peer').name, 'confirmed')
    fail = true
    time = 5000
    presence.sweep()
    await pause(0)
    assert.equal(visible.size, 0)
    fail = false
    await presence.found(candidate)
    assert.equal(visible.size, 1)
    time = 15000
    presence.sweep()
    assert.equal(visible.size, 0)
  } finally {
    presence.close()
  }
  let reply
  const late = createDiscoveryPresence({
    probe: () =>
      new Promise((resolve) => {
        reply = resolve
      }),
    found: () => assert.fail('stale result'),
    removed: () => {}
  })
  const request = late.found(candidate)
  late.removed('peer')
  reply(hello)
  await request
  late.close()
})

test('presence refreshes same-address organizations and prefers a safe hello summary', async () => {
  let time = 0
  const hello = { id: 'peer', name: 'confirmed' }
  const visible = new Map()
  const presence = createDiscoveryPresence({
    now: () => time,
    interval: 5000,
    ttl: 30000,
    probe: async () => hello,
    found: (value) => visible.set(value.id, value),
    removed: (id) => visible.delete(id)
  })
  const candidate = {
    id: 'peer',
    name: 'untrusted',
    address: '127.0.0.1:18898',
    organization: { id: 'org', name: '公告组织', members: 1 }
  }
  try {
    await presence.found(candidate)
    assert.deepEqual(visible.get('peer').organization, {
      id: 'org',
      name: '公告组织',
      members: 1
    })

    time = 5000
    hello.organization = {
      id: 'org',
      name: '握手组织',
      members: ['peer', 'other'],
      token: 'must-not-leak',
      capability: 'must-not-leak'
    }
    await presence.found(candidate)
    assert.deepEqual(visible.get('peer').organization, {
      id: 'org',
      name: '握手组织',
      members: 2
    })
    assert.deepEqual(Object.keys(visible.get('peer').organization).sort(), [
      'id',
      'members',
      'name'
    ])

    time = 10000
    delete hello.organization
    await presence.found({
      ...candidate,
      organization: { id: 'org', name: '公告新名称', members: 3 }
    })
    assert.deepEqual(visible.get('peer').organization, {
      id: 'org',
      name: '公告新名称',
      members: 3
    })
  } finally {
    presence.close()
  }
})

test('Bonjour resolvers are one-shot, deduplicated, bounded and timeout; late callbacks cannot resurrect removed records', async () => {
  const children = [],
    found = []
  const spawn = (args) => {
    const p = new EventEmitter()
    p.args = args
    p.stdout = new PassThrough()
    p.stops = 0
    p.stop = () => {
      p.stops++
      p.emit('exit', 0)
    }
    children.push(p)
    return p
  }
  let resolveHost
  const stop = discoverBonjour(
    { id: 'self', name: 'test' },
    18898,
    'test',
    (v) => found.push(v),
    () => {},
    {
      spawn,
      cleanup: async () => {},
      resolve: () =>
        new Promise((r) => {
          resolveHost = r
        }),
      timeout: 30,
      interval: 10000
    }
  )
  try {
    await pause(0)
    const browser = children.find((p) => p.args[0] === '-B')
    const add = '00:00 Add 2 1 local. _hiveward._tcp. Test peer\n'
    browser.stdout.write(add + add)
    const resolver = children.find((p) => p.args[0] === '-L')
    assert.equal(children.filter((p) => p.args[0] === '-L').length, 1)
    resolver.stdout.write('Test can be reached at test.local.:18898 (interface 1)\n id=peer v=1\n')
    resolveHost('127.0.0.1')
    await pause(0)
    assert.equal(found.length, 1)
    assert.equal(resolver.stops, 1)
    for (let i = 0; i < 40; i++) {
      browser.stdout.write(`00:00 Add 2 1 local. _hiveward._tcp. Peer${i}\n`)
    }
    assert.equal(children.filter((p) => p.args[0] === '-L' && !p.stops).length, 16)
    await pause(60)
    assert.equal(children.filter((p) => p.args[0] === '-L' && !p.stops).length, 0)
  } finally {
    stop()
  }
  assert.ok(children.every((p) => p.stops > 0))
})

test('Bonjour TXT carries only encoded public organization metadata after the version', async () => {
  const children = [],
    found = []
  let organization = { id: 'old', name: 'Old', members: 1 }
  let initialized
  const spawn = (args) => {
    const child = new EventEmitter()
    child.args = args
    child.stdout = new PassThrough()
    child.stops = 0
    child.stop = () => {
      child.stops++
      child.emit('exit', 0)
    }
    children.push(child)
    return child
  }
  const stop = discoverBonjour(
    { id: 'self', name: 'test', token: 'machine-token-must-not-leak' },
    18898,
    'test',
    (value) => found.push(value),
    () => {},
    {
      spawn,
      cleanup: () =>
        new Promise((resolve) => {
          initialized = resolve
        }),
      resolve: async () => '127.0.0.1',
      organization: () => organization
    }
  )
  organization = {
    id: 'org=中文',
    name: '研发 团队 = 中文',
    members: 2,
    memberIds: ['member-list-must-not-leak'],
    token: 'org-token-must-not-leak',
    capability: 'org-capability-must-not-leak'
  }
  initialized()
  try {
    await pause(0)
    const registration = children.find((child) => child.args[0] === '-R')
    assert.deepEqual(registration.args.slice(5), [
      'id=self',
      'v=test',
      `org=${encodeURIComponent('org=中文')}`,
      `orgName=${encodeURIComponent('研发 团队 = 中文')}`,
      'orgMembers=2'
    ])
    const registered = registration.args.join(' ')
    for (const secret of [
      'member-list-must-not-leak',
      'org-token-must-not-leak',
      'org-capability-must-not-leak',
      'machine-token-must-not-leak'
    ]) {
      assert.equal(registered.includes(secret), false)
    }

    const browser = children.find((child) => child.args[0] === '-B')
    browser.stdout.write('00:00 Add 2 1 local. _hiveward._tcp. Test peer\n')
    children
      .find((child) => child.args[0] === '-L')
      .stdout.write(
        `Test can be reached at test.local.:18898 (interface 1)\n id=peer v=1 org=${encodeURIComponent('org=中文')} orgName=${encodeURIComponent('研发 团队 = 中文')} orgMembers=2 token=must-not-leak members=peer,other\n`
      )
    await until(() => found.length === 1)
    assert.deepEqual(found[0].organization, {
      id: 'org=中文',
      name: '研发 团队 = 中文',
      members: 2
    })
    assert.deepEqual(Object.keys(found[0]).sort(), [
      'address',
      'id',
      'lastSeenAt',
      'name',
      'organization',
      'version'
    ])

    browser.stdout.write('00:00 Add 2 1 local. _hiveward._tcp. Bad peer\n')
    children
      .find((child) => child.args[0] === '-L' && child.args[1] === 'Bad peer')
      .stdout.write(
        'Bad can be reached at bad.local.:18899 (interface 1)\n id=bad org=org orgName=%E0%A4%A orgMembers=1\n'
      )
    await until(() => found.length === 2)
    assert.equal(found[1].organization, undefined)
  } finally {
    await stop()
  }
})

test('startup cleanup requires orphan parent, executable and recorded process birth identity', () => {
  const identity = 'Mon Nov  2 05:00:00 2026 /usr/bin/dns-sd -B _hw-test._tcp'
  assert.equal(ownedOrphan(` 1 ${identity}`, identity), true)
  assert.equal(ownedOrphan(` 42 ${identity}`, identity), false)
  assert.equal(ownedOrphan(` 1 ${identity}`, identity.replace('05:00:00', '05:00:01')), false)
  assert.equal(ownedOrphan(' 1 /bin/sleep', '/bin/sleep'), false)
})

test(
  'macOS guardian reaps R/B/L on normal close and parent SIGKILL; startup reaps owned orphan',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hiveward-bonjour-test-'))
    const moduleUrl = new URL('./bonjour-process.mjs', import.meta.url).href
    const processes = []
    const directories = []
    async function state(pid) {
      const r = await runProcess({
        program: '/bin/ps',
        args: ['-p', String(pid), '-o', 'stat='],
        timeoutMs: 1000
      })
      return r.stdout.trim()
    }
    async function start(args) {
      const directory = join(root, String(processes.length))
      directories.push(directory)
      const source = `import {spawnBonjour} from ${JSON.stringify(moduleUrl)}; const p=spawnBonjour(${JSON.stringify(args)},${JSON.stringify(directory)}); console.log(p.pid); process.stdin.resume(); process.stdin.on('data',()=>p.stop());`
      const parent = spawnProcess({
        program: process.execPath,
        args: ['--input-type=module', '-e', source],
        stdio: ['pipe', 'pipe', 'pipe']
      })
      processes.push(parent)
      let output = ''
      parent.stdout.on('data', (b) => {
        output += b
      })
      let files = []
      await until(async () => {
        files = await readdir(directory).catch(() => [])
        files = files.filter((name) => !name.endsWith('.tmp'))
        return files.length && output.trim()
      })
      let pid
      await until(async () => {
        pid = Number((await readFile(join(directory, files[0]), 'utf8')).split('\n')[0])
        return pid > 0
      })
      return { parent, pid, guardian: Number(output.trim()), directory }
    }
    try {
      for (const args of [
        ['-R', 'HiveWard cleanup test', '_hw-test._tcp', 'local', '18898'],
        ['-B', '_hw-test._tcp'],
        ['-L', 'nonexistent cleanup test', '_hw-test._tcp', 'local']
      ]) {
        for (const mode of ['close', 'kill']) {
          const entry = await start(args)
          if (mode === 'close') {
            entry.parent.stdin.write('stop\n')
          } else {
            entry.parent.kill('SIGKILL')
          }
          await until(async () => !(await state(entry.pid)))
          entry.parent.kill('SIGTERM')
        }
      }
      const orphan = await start(['-B', '_hw-test._tcp'])
      process.kill(orphan.guardian, 'SIGKILL')
      await until(async () => {
        const r = await runProcess({
          program: '/bin/ps',
          args: ['-p', String(orphan.pid), '-o', 'ppid='],
          timeoutMs: 1000
        })
        return r.stdout.trim() === '1'
      })
      await cleanupBonjourOrphans(orphan.directory)
      await until(async () => {
        const s = await state(orphan.pid)
        return !s || s.startsWith('Z')
      })
    } finally {
      for (const p of processes) {
        if (p.exitCode === null && p.signalCode === null) {
          const exited = once(p, 'exit')
          p.kill('SIGTERM')
          await exited
        }
      }
      for (const directory of directories) {
        await cleanupBonjourOrphans(directory)
      }
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('legacy registration cleanup is scoped to orphan machine id and service port', () => {
  const line = ' 123 1 dns-sd -R Test Mac _hiveward._tcp local 18898 id=test-id v=1'
  assert.equal(legacyRegistrationPid(line, { id: 'test-id' }, 18898), 123)
  assert.equal(legacyRegistrationPid(line, { id: 'other-id' }, 18898), null)
  assert.equal(legacyRegistrationPid(line, { id: 'test-id' }, 18788), null)
  assert.equal(
    legacyRegistrationPid(line.replace('123 1', '123 99'), { id: 'test-id' }, 18898),
    null
  )
  assert.equal(
    legacyRegistrationPid(' 123 1 dns-sd -B _hiveward._tcp', { id: 'test-id' }, 18898),
    null
  )
})

test('Bonjour removed service ignores an outstanding address resolution', async () => {
  const children = []
  let resolveHost
  const stop = discoverBonjour(
    { id: 'self', name: 'test' },
    18898,
    'test',
    () => assert.fail('resurrected service'),
    () => {},
    {
      cleanup: async () => {},
      spawn: (args) => {
        const child = new EventEmitter()
        child.args = args
        child.stdout = new PassThrough()
        child.stop = () => child.emit('exit', 0)
        children.push(child)
        return child
      },
      resolve: () =>
        new Promise((resolve) => {
          resolveHost = resolve
        })
    }
  )
  try {
    await pause(0)
    const browser = children.find((p) => p.args[0] === '-B')
    browser.stdout.write('00:00 Add 2 1 local. _hiveward._tcp. Test peer\n')
    children
      .find((p) => p.args[0] === '-L')
      .stdout.write('Test can be reached at test.local.:18898 (interface 1)\n id=peer\n')
    browser.stdout.write('00:00 Rmv 2 1 local. _hiveward._tcp. Test peer\n')
    resolveHost('127.0.0.1')
    await pause(0)
  } finally {
    stop()
  }
})

test('Bonjour close waits for initialization and all guardian close acknowledgements', async () => {
  let initialized
  const init = new Promise((resolve) => {
    initialized = resolve
  })
  const early = discoverBonjour(
    { id: 'test', name: 'test' },
    18898,
    'test',
    () => {},
    () => {},
    {
      cleanup: () => init,
      spawn: () => assert.fail('spawned after shutdown')
    }
  )
  let earlyClosed = false
  const pending = early().then(() => {
    earlyClosed = true
  })
  await pause(0)
  assert.equal(earlyClosed, false)
  initialized()
  await pending
  const acknowledgements = []
  const stop = discoverBonjour(
    { id: 'test', name: 'test' },
    18898,
    'test',
    () => {},
    () => {},
    {
      cleanup: async () => {},
      spawn: () => {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        const closed = new Promise((resolve) => {
          acknowledgements.push(resolve)
        })
        child.stop = () => {
          child.emit('exit', 0)
          return closed
        }
        return child
      }
    }
  )
  await pause(0)
  let closed = false
  const finished = stop().then(() => {
    closed = true
  })
  await pause(0)
  assert.equal(closed, false)
  assert.equal(acknowledgements.length, 2)
  for (const acknowledge of acknowledgements) {
    acknowledge()
  }
  await finished
})

test(
  'guardian owns cancellation during startup and L has an independent deadline with stdin held open',
  {
    skip: process.platform !== 'darwin',
    timeout: 15000
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hiveward-bonjour-race-'))
    const children = []
    try {
      for (let round = 0; round < 4; round++) {
        const batch = Array.from({ length: 8 }, () =>
          spawnBonjour(['-L', 'cancel during startup', '_hw-test._tcp', 'local'], root)
        )
        children.push(...batch)
        await Promise.all(batch.map((child) => child.stop()))
        assert.deepEqual(await readdir(root), [])
      }
      const child = spawnBonjour(['-L', 'deadline with open stdin', '_hw-test._tcp', 'local'], root)
      children.push(child)
      await once(child, 'close')
      assert.equal(child.stdin.writableEnded, false)
      assert.deepEqual(await readdir(root), [])
    } finally {
      await Promise.all(children.map((child) => child.stop()))
      await rm(root, { recursive: true, force: true })
    }
  }
)
