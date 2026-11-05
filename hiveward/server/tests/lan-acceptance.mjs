// Real macOS Bonjour + HiveWard integration. Never connects to the production bridge.
// Run: node server/tests/lan-acceptance.mjs
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const cwd = fileURLToPath(new URL('../../', import.meta.url))
const hiwd = fileURLToPath(new URL('../hiwd.mjs', import.meta.url))
const dirs = [join(tmpdir(), 'hiveward-a'), join(tmpdir(), 'hiveward-b')]
const owned = [],
  processes = new Map()
let handle, aid, bid
const A = 'http://127.0.0.1:8791',
  B = 'http://127.0.0.1:8793'
async function api(base, path, body, headers = {}, expected = 200) {
  const method = body === undefined ? 'GET' : 'POST'
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  })
  const data = await r.json()
  console.log(`${method} ${base}${path} → ${r.status} ${JSON.stringify(data)}`)
  assert.equal(r.status, expected)
  return data
}
async function quiet(base, path) {
  return (await fetch(base + path)).json()
}
async function until(fn, ms = 30000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      if (await fn()) {
        return
      }
    } catch {}
    await sleep(300)
  }
  throw new Error('Timed out waiting for condition')
}
async function start(index) {
  const port = index ? 8793 : 8791,
    lanPort = port + 1
  console.log(
    `$ HIVEWARD_DATA_DIR=${dirs[index]} HIVEWARD_PORT=${port} HIVEWARD_LAN_PORT=${lanPort} node server/hiveward-bridge.mjs`
  )
  const child = spawn(process.execPath, ['server/hiveward-bridge.mjs'], {
    cwd,
    env: {
      ...process.env,
      HIVEWARD_DATA_DIR: dirs[index],
      HIVEWARD_PORT: String(port),
      HIVEWARD_LAN_PORT: String(lanPort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  processes.set(index, child)
  child.stdout.on('data', (b) => process.stdout.write(b))
  child.stderr.on('data', (b) => process.stderr.write(b))
  await until(async () => {
    if (child.exitCode !== null) {
      throw new Error('bridge exited')
    }
    return (await quiet(index ? B : A, '/api/machines')).machines.length > 0
  })
}
async function stop(index) {
  const child = processes.get(index)
  if (!child || child.exitCode !== null) {
    return
  }
  console.log(`$ kill -TERM ${child.pid}`)
  const done = once(child, 'exit')
  child.kill('SIGTERM')
  await done
  processes.delete(index)
}
try {
  for (const dir of dirs) {
    mkdirSync(dir)
    owned.push(dir)
  }
  await start(0)
  await start(1)
  aid = (await quiet(A, '/api/machines')).machines[0].id
  bid = (await quiet(B, '/api/machines')).machines[0].id
  console.log('\n1. Bonjour discovery')
  await until(
    async () =>
      (await quiet(A, '/api/machines')).machines.some((m) => m.id === bid && !m.paired) &&
      (await quiet(B, '/api/machines')).machines.some((m) => m.id === aid && !m.paired)
  )
  await api(A, '/api/machines')
  await api(B, '/api/machines')
  console.log('\n2. Bidirectional pairing + summaries')
  const code = await api(A, '/api/machines/pair-code', {})
  await api(B, '/api/machines/pair', { machineId: aid, code: code.code })
  await until(
    async () =>
      (await quiet(A, '/api/machines')).machines.some(
        (m) => m.id === bid && m.paired && m.status === 'online' && m.summary
      ) &&
      (await quiet(B, '/api/machines')).machines.some(
        (m) => m.id === aid && m.paired && m.status === 'online' && m.summary
      )
  )
  await api(A, '/api/machines')
  await api(B, '/api/machines')
  for (const dir of dirs) {
    assert.equal(statSync(`${dir}/peers.json`).mode & 0o777, 0o600)
    console.log(`stat ${dir}/peers.json → 600`)
  }
  console.log('\n3. Wrong code, reuse, five-attempt lock')
  await api(B, '/api/machines/pair', { machineId: aid, code: code.code }, {}, 401)
  const newer = await api(A, '/api/machines/pair-code', {})
  await api(
    B,
    '/api/machines/pair',
    { machineId: aid, code: newer.code === '000000' ? '111111' : '000000' },
    {},
    401
  )
  const bcode = await api(B, '/api/machines/pair-code', {})
  for (let i = 0; i < 5; i++) {
    await api(
      A,
      '/api/machines/pair',
      { machineId: bid, code: bcode.code === '000000' ? '111111' : '000000' },
      {},
      i === 4 ? 429 : 401
    )
  }
  await api(A, '/api/machines/pair', { machineId: bid, code: bcode.code }, {}, 429)
  await api(B, '/api/machines/pair-code', {}, {}, 429)
  console.log('\n4. LAN authorization and forbidden routes')
  await api('http://127.0.0.1:8792', '/api/overview', undefined, {}, 401)
  await api(
    'http://127.0.0.1:8792',
    '/api/overview',
    undefined,
    { authorization: `Bearer ${'0'.repeat(64)}` },
    401
  )
  const peerB = JSON.parse(readFileSync(join(dirs[1], 'peers.json')))[0]
  const auth = { authorization: `Bearer ${peerB.outboundToken}` }
  for (const path of [
    '/api/app/status',
    `/api/m/${bid}/overview`,
    '/api/machines',
    '/api/machines/pair-code',
    '/'
  ]) {
    await api('http://127.0.0.1:8792', path, undefined, auth, 403)
  }
  console.log('\n5. Real GET and POST forwarding')
  await api(B, `/api/m/${aid}/overview`)
  const terminals = await api(B, `/api/m/${aid}/hiveward/terminals`)
  const project =
    terminals.terminals[0]?.project ?? (await quiet(A, '/api/hiveward/projects')).projects[0].path
  handle = (
    await api(B, `/api/m/${aid}/hiveward/terminals`, {
      project,
      title: 'HiveWard LAN acceptance shell'
    })
  ).handle
  await api(B, `/api/m/${aid}/hiveward/terminals/${encodeURIComponent(handle)}/send`, {
    text: 'echo HIVEWARD_LAN_POST_OK'
  })
  await until(async () =>
    (
      await quiet(B, `/api/m/${aid}/hiveward/terminals/${encodeURIComponent(handle)}/screen`)
    ).text.includes('HIVEWARD_LAN_POST_OK')
  )
  await api(B, `/api/m/${aid}/hiveward/terminals/${encodeURIComponent(handle)}/close`, {})
  handle = null
  await api(B, `/api/m/${bid}/overview`)
  console.log('\n6. Offline / 503 / restart recovery')
  await stop(0)
  await until(
    async () =>
      (await quiet(B, '/api/machines')).machines.find((m) => m.id === aid)?.status === 'offline'
  )
  await api(B, '/api/machines')
  await api(B, `/api/m/${aid}/overview`, undefined, {}, 503)
  await start(0)
  await until(
    async () => (await quiet(B, '/api/machines')).machines.find((m) => m.id === aid)?.summary
  )
  await api(B, '/api/machines')
  console.log('\n7. CLI machines / --on name prefix')
  await api(B, `/api/machines/${aid}/rename`, { name: 'Studio-A' })
  for (const args of [['machines'], ['agents', '--on', 'studio']]) {
    console.log(`$ HIVEWARD_BRIDGE=${B} hiwd ${args.join(' ')}`)
    console.log(
      execFileSync(process.execPath, [hiwd, ...args], {
        env: { ...process.env, HIVEWARD_BRIDGE: B },
        encoding: 'utf8'
      })
    )
  }
  console.log('\n8. Unpair revokes both tokens')
  await api(B, `/api/machines/${aid}/unpair`, {})
  assert.equal(JSON.parse(readFileSync(join(dirs[0], 'peers.json'))).length, 0)
  assert.equal(JSON.parse(readFileSync(join(dirs[1], 'peers.json'))).length, 0)
  await api('http://127.0.0.1:8792', '/api/overview', undefined, auth, 401)
  await api(
    'http://127.0.0.1:8794',
    '/api/overview',
    undefined,
    { authorization: `Bearer ${peerB.inboundToken}` },
    401
  )
  await api(A, '/api/machines')
  await api(B, '/api/machines')
  console.log('\n9. Manual address pairing (CLI)')
  const manual = await api(A, '/api/machines/pair-code', {})
  console.log(`$ HIVEWARD_BRIDGE=${B} hiwd machines pair --address 127.0.0.1:8792 ${manual.code}`)
  console.log(
    execFileSync(
      process.execPath,
      [hiwd, 'machines', 'pair', '--address', '127.0.0.1:8792', manual.code],
      {
        env: { ...process.env, HIVEWARD_BRIDGE: B },
        encoding: 'utf8'
      }
    )
  )
  await until(
    async () =>
      (await quiet(A, '/api/machines')).machines.some((m) => m.id === bid && m.summary) &&
      (await quiet(B, '/api/machines')).machines.some((m) => m.id === aid && m.summary)
  )
  await api(A, '/api/machines')
  await api(B, '/api/machines')
  const startTime = performance.now()
  for (let i = 0; i < 20; i++) {
    await quiet(B, '/api/machines')
  }
  console.log(`20 cached GET /api/machines: ${Math.round(performance.now() - startTime)}ms total`)
  console.log('PASS: all nine acceptance items')
} finally {
  if (handle) {
    await api(A, `/api/hiveward/terminals/${encodeURIComponent(handle)}/close`, {}).catch(() => {})
  }
  await stop(0)
  await stop(1)
  for (const dir of owned) {
    rmSync(dir, { recursive: true })
    console.log(`rm -r ${dir} → removed`)
  }
}
