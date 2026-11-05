import assert from 'node:assert/strict'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess, spawnProcess } from '@hiveward/process-host'
import { forceTerminateProcessTree } from '@hiveward/process-host/process-tree-termination'

const log = (message) => console.log(`[windows-packaged-smoke] ${message}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort(used) {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const { port } = server.address()
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()))
  })
  if (used.has(port)) {
    return freePort(used)
  }
  used.add(port)
  return port
}

async function waitForCockpit(app, origin, getLaunchError) {
  const deadline = Date.now() + 90_000
  let lastError
  while (Date.now() < deadline) {
    if (getLaunchError()) {
      throw getLaunchError()
    }
    if (app.exitCode !== null || app.signalCode !== null) {
      throw new Error(
        `HiveWard exited before readiness (code=${app.exitCode}, signal=${app.signalCode})`
      )
    }
    try {
      const [overviewResponse, pageResponse] = await Promise.all(
        [`${origin}/api/overview`, `${origin}/`].map((url) =>
          fetch(url, { signal: AbortSignal.timeout(2_000) })
        )
      )
      assert.equal(overviewResponse.status, 200, 'overview HTTP status')
      assert.equal(pageResponse.status, 200, 'cockpit HTTP status')
      const overview = await overviewResponse.json()
      const page = await pageResponse.text()
      assert.equal(overview.health?.reachable, true, 'HiveWard runtime must be reachable')
      assert.ok(Array.isArray(overview.businesses), 'overview businesses must be an array')
      assert.match(page, /<title>HiveWard<\/title>/, 'cockpit title')
      assert.match(page, /<div id="root"><\/div>/, 'cockpit root')
      log(
        `PASS bridge and cockpit ready; runtime=${overview.health.runtimeState ?? 'unknown'} businesses=${overview.businesses.length}`
      )
      return
    } catch (error) {
      lastError = error
      await sleep(500)
    }
  }
  throw new Error(
    `Timed out waiting for ${origin}: ${lastError?.stack ?? lastError ?? 'no response'}`
  )
}

async function run() {
  const appPath = resolve('dist/win-unpacked/HiveWard.exe')
  const cliPath = resolve('dist/win-unpacked/resources/hiveward/bin/hiwd.cmd')
  await Promise.all([access(appPath), access(cliPath)])

  const tempRoot = await mkdtemp(join(tmpdir(), 'hiveward-windows-packaged-smoke-'))
  let app
  let launchError
  try {
    const used = new Set()
    const [port, lanPort, lanTlsPort, discoveryPort] = await Promise.all(
      Array.from({ length: 4 }, () => freePort(used))
    )
    const origin = `http://127.0.0.1:${port}`
    const env = {
      ...process.env,
      HIVEWARD_USER_DATA_PATH: join(tempRoot, 'user-data'),
      HIVEWARD_DATA_DIR: join(tempRoot, 'hiveward-data'),
      HIVEWARD_PORT: String(port),
      HIVEWARD_LAN_PORT: String(lanPort),
      HIVEWARD_LAN_TLS_PORT: String(lanTlsPort),
      HIVEWARD_DISCOVERY_PORT: String(discoveryPort),
      HIVEWARD_BRIDGE: origin,
      HIVEWARD_BACKGROUND_LAUNCH: '1'
    }
    delete env.ELECTRON_RUN_AS_NODE
    log(`starting ${appPath}; profile=${tempRoot}`)
    log(`ports local=${port} lan=${lanPort} tls=${lanTlsPort} discovery=${discoveryPort}`)
    app = spawnProcess({
      program: appPath,
      args: [],
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    log(`HiveWard pid=${app.pid}`)
    app.once('error', (error) => {
      launchError = error
      console.error(`[windows-packaged-smoke] app launch error: ${error.stack ?? error}`)
    })
    app.stdout.on('data', (chunk) => process.stdout.write(`[HiveWard stdout] ${chunk}`))
    app.stderr.on('data', (chunk) => process.stderr.write(`[HiveWard stderr] ${chunk}`))

    await waitForCockpit(app, origin, () => launchError)
    const result = await runProcess({
      program: cliPath,
      args: ['agents'],
      env,
      timeoutMs: 30_000,
      terminationBarrier: true
    })
    if (result.stdout) {
      process.stdout.write(`[hiwd stdout] ${result.stdout}`)
    }
    if (result.stderr) {
      process.stderr.write(`[hiwd stderr] ${result.stderr}`)
    }
    assert.equal(result.timedOut, false, 'hiwd agents timed out')
    assert.equal(
      result.code,
      0,
      `hiwd agents failed (code=${result.code}, signal=${result.signal}, timedOut=${result.timedOut})`
    )
    log('PASS packaged resources/hiveward/bin/hiwd.cmd agents exited 0')
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = once(app, 'exit')
      const terminated = await forceTerminateProcessTree(app)
      log(`terminated only spawned HiveWard tree pid=${app.pid}; verified=${terminated}`)
      await Promise.race([exited, sleep(5_000)])
    }
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    log(`removed temporary profile ${tempRoot}`)
  }
}

if (process.platform !== 'win32') {
  log('SKIP: packaged Windows smoke requires win32')
} else {
  await run()
}
