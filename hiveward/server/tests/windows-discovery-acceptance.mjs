import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { spawnProcess } from '@hiveward/process-host'

const root = await mkdtemp(join(tmpdir(), 'hiveward-discovery-'))
const children = []
const ports = []
async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function until(check) {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('Discovery acceptance timed out')
}
const machines = async (i) =>
  (await (await fetch(`http://127.0.0.1:${ports[i]}/api/machines`)).json()).machines
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
}
try {
  const discoveryPort = await freePort()
  for (let i = 0; i < 2; i++) {
    const dir = join(root, String(i))
    await mkdir(dir)
    const port = await freePort(),
      lan = await freePort(),
      tls = await freePort()
    ports.push(port)
    const env = {
      ...process.env,
      HIVEWARD_BACKGROUND_LAUNCH: '1',
      HIVEWARD_DATA_DIR: dir,
      HIVEWARD_PORT: String(port),
      HIVEWARD_LAN_PORT: String(lan),
      HIVEWARD_LAN_TLS_PORT: String(tls),
      HIVEWARD_DISCOVERY_PORT: String(discoveryPort),
      HIVEWARD_RUNTIME_META: join(dir, 'missing-runtime.json')
    }
    const child = spawnProcess({
      program: process.execPath,
      args: ['hiveward/server/tests/exit-region-bridge-fixture.mjs'],
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    children.push(child)
    child.stderr.on('data', (data) => process.stderr.write(data))
    console.log(
      `instance ${i}: pid=${child.pid} data=${dir} local=${port} lan=${lan} tls=${tls} udp=${discoveryPort}`
    )
    await until(async () => (await machines(i)).some((m) => m.self))
  }
  const a = (await machines(0)).find((m) => m.self).id
  const b = (await machines(1)).find((m) => m.self).id
  await until(
    async () =>
      (await machines(0)).some((m) => m.id === b && m.discovered) &&
      (await machines(1)).some((m) => m.id === a && m.discovered)
  )
  assert.equal((await machines(0)).find((m) => m.id === b).platform, process.platform)
  console.log(`PASS independent bridges discover each other over UDP, platform=${process.platform}`)
  await stop(children[1])
  await until(async () => !(await machines(0)).some((m) => m.id === b && m.discovered))
  console.log('PASS stopped peer disappears')
  await stop(children[0])
  for (let i = 0; i < 2; i++) {
    const registry = await readdir(join(root, String(i), 'bonjour-processes')).catch(() => [])
    assert.deepEqual(registry, [])
    assert.ok(children[i].exitCode !== null || children[i].signalCode !== null)
  }
  console.log('PASS both child processes exited; no dns-sd children or registrations created')
} finally {
  await Promise.all(children.map(stop))
  await rm(root, { recursive: true, force: true })
}
