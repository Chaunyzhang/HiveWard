import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { runProcess, spawnProcess } from '@hiveward/process-host'
import { forceTerminateProcessTree } from '@hiveward/process-host/process-tree-termination'

const log = (message) => console.log(`[hiveward-packaged-smoke] ${message}`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const repoRoot = resolve(import.meta.dirname, '../../..')
const appPath =
  process.env.HIVEWARD_SMOKE_APP ??
  join(repoRoot, 'dist/mac-arm64/HiveWard.app/Contents/MacOS/HiveWard')
const resources = resolve(dirname(appPath), '..', 'Resources')
const newEntry = join(resources, 'hiveward/server/hiwd.mjs')
const marker = '.hiveward-migration.json'
const launchTimeoutMs = 180_000

async function freePorts(count) {
  const used = new Set()
  const ports = []
  while (ports.length < count) {
    const server = createServer()
    await new Promise((listening, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', listening)
    })
    const { port } = server.address()
    await new Promise((closed, reject) => {
      server.close((error) => (error ? reject(error) : closed()))
    })
    if (!used.has(port)) {
      used.add(port)
      ports.push(port)
    }
  }
  return ports
}

function appEnvironment(home, ports) {
  const origin = `http://127.0.0.1:${ports.http}`
  return {
    // CFFIXED_USER_HOME 让 Cocoa 使用假家目录；HOME 让 Node 的 homedir() 一致。
    HOME: home,
    CFFIXED_USER_HOME: home,
    USER: process.env.USER ?? 'hiveward-smoke',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'hiveward-smoke',
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    HIVEWARD_BACKGROUND_LAUNCH: '1',
    HIVEWARD_PORT: String(ports.http),
    HIVEWARD_LAN_PORT: String(ports.lan),
    HIVEWARD_LAN_TLS_PORT: String(ports.lanTls),
    HIVEWARD_DISCOVERY_PORT: String(ports.discovery),
    HIVEWARD_BRIDGE: origin
  }
}

async function writeLegacyProfile(source, runtimePid) {
  await mkdir(join(source, 'opc-data'), { recursive: true })
  await writeFile(
    join(source, 'opc-data', 'state.json'),
    `${JSON.stringify({ company: '打包冒烟' }, null, 2)}\n`
  )
  for (const partition of ['opc-alpha', 'opc-google']) {
    await mkdir(join(source, 'Partitions', partition), { recursive: true })
    await writeFile(join(source, 'Partitions', partition, 'Cookies'), Buffer.from([1, 2, 3]))
  }
  await writeFile(join(source, 'opc-runtime.json'), `${JSON.stringify({ pid: runtimePid })}\n`)
}

async function deadPid() {
  const exited = spawn('/usr/bin/true', { stdio: 'ignore' })
  await once(exited, 'exit')
  return exited.pid
}

async function waitForBridge(app, origin, launchError) {
  const deadline = Date.now() + launchTimeoutMs
  let lastError
  while (Date.now() < deadline) {
    const failure = launchError()
    if (failure) {
      throw failure
    }
    if (app.exitCode !== null || app.signalCode !== null) {
      throw new Error(`HiveWard 在后台就绪前退出（code=${app.exitCode}, signal=${app.signalCode}）`)
    }
    try {
      const migration = await fetch(`${origin}/api/migration`, {
        signal: AbortSignal.timeout(2_000)
      })
      if (migration.status !== 200) {
        throw new Error(`/api/migration HTTP ${migration.status}`)
      }
      const page = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2_000) })
      const html = await page.text()
      assert.equal(page.status, 200, '驾驶舱页面 HTTP 状态')
      assert.match(html, /<title>HiveWard<\/title>/, '驾驶舱页面标题')
      return await migration.json()
    } catch (error) {
      lastError = error
      await sleep(500)
    }
  }
  const detail =
    lastError instanceof Error ? (lastError.stack ?? lastError.message) : String(lastError)
  throw new Error(`等待 ${origin} 超时：${detail}`)
}

async function forwardedCli(env, home) {
  const mode = await stat(newEntry)
  assert.notEqual(mode.mode & 0o111, 0, 'Resources/hiveward/server/hiwd.mjs 必须可执行')
  const alias = join(home, 'hiwd-smoke')
  await symlink(newEntry, alias)
  let last
  // 引擎刚起来时不同命令依赖的服务不完全一致；任意一条真正走通隔离端口即可。
  for (const args of [['agents'], ['overview'], ['projects'], ['tasks']]) {
    const result = await runProcess({
      program: alias,
      args,
      env,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      terminationBarrier: true
    })
    if (result.code === 0) {
      log(`PASS CLI 入口 ${args.join(' ')} 连上隔离实例`)
      return
    }
    last = result
  }
  throw new Error(`CLI 入口无法连上隔离实例（code=${last?.code}, stderr=${last?.stderr ?? ''}）`)
}

function profileNotice(notices) {
  assert.ok(Array.isArray(notices) && notices.length > 0, '迁移状态必须返回 notice')
  return notices[0]
}

async function migratedFiles(source, target) {
  const record = JSON.parse(await readFile(join(target, marker), 'utf8'))
  assert.equal(record.phase, 'complete')
  assert.ok(existsSync(join(target, 'hiveward-data', 'state.json')), '迁移后业务资料存在')
  assert.equal((await lstat(source)).isSymbolicLink(), true, '旧路径保留兼容链接')
  const backup = (await readdir(dirname(source))).find((name) =>
    name.startsWith('OPC-Engine.migrated-')
  )
  assert.ok(backup, '旧资料备份存在')
}

async function runScenario({ name, prepare, verify }) {
  const root = await mkdtemp('/tmp/hws-')
  let app
  let live
  try {
    const home = join(root, 'home')
    const support = join(home, 'Library', 'Application Support')
    const launchAgents = join(home, 'Library', 'LaunchAgents')
    await mkdir(launchAgents, { recursive: true })
    await mkdir(support, { recursive: true })
    assert.deepEqual(await readdir(launchAgents), [], '假家目录 LaunchAgents 必须为空')
    const source = join(support, 'OPC-Engine')
    const target = join(support, 'HiveWard')
    const prepared = await prepare({ home, support, source, target, root })
    live = prepared?.live
    const [http, lan, lanTls, discovery] = await freePorts(4)
    const ports = { http, lan, lanTls, discovery }
    const origin = `http://127.0.0.1:${http}`
    const env = appEnvironment(home, ports)
    let launchError
    log(`${name}: 启动 ${appPath}`)
    log(`${name}: 端口 ${http}/${lan}/${lanTls}/${discovery}，家目录 ${home}`)
    app = spawnProcess({
      program: appPath,
      // 冒烟用假家目录，绝不能碰系统钥匙串；否则会弹出「找不到用于储存 OPC Engine Key 的钥匙串」。
      args: ['--password-store=basic', '--use-mock-keychain'],
      env,
      // 独立进程组，forceTerminateProcessTree 才能按 -pid 一次收掉整个 App。
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    log(`${name}: HiveWard pid=${app.pid}`)
    app.once('error', (error) => {
      launchError = error
    })
    app.stdout.on('data', (chunk) => process.stdout.write(`[${name} stdout] ${chunk}`))
    app.stderr.on('data', (chunk) => process.stderr.write(`[${name} stderr] ${chunk}`))
    // 兜底超时：无论卡在哪个启动阶段都必须关掉本次进程，不能留下挂着的正式包。
    const watchdog = setTimeout(() => {
      log(`${name}: 启动超时，强制关闭 pid=${app.pid}`)
      void forceTerminateProcessTree(app)
    }, launchTimeoutMs + 15_000)
    watchdog.unref()
    let notices
    try {
      notices = await waitForBridge(app, origin, () => launchError)
    } finally {
      clearTimeout(watchdog)
    }
    log(`${name}: 后台 HTTP 已就绪，迁移 notice=${JSON.stringify(notices)}`)
    await forwardedCli(env, home)
    await verify({ home, support, source, target, notices, origin })
    log(`${name}: PASS`)
  } finally {
    if (live && live.exitCode === null) {
      live.kill()
    }
    if (app) {
      const exited = app.exitCode === null && app.signalCode === null ? once(app, 'exit') : null
      const terminated =
        app.exitCode === null && app.signalCode === null
          ? await forceTerminateProcessTree(app)
          : true
      // 终端后台进程可能另起进程组，按本次独有的假家目录再兜底清一遍。
      try {
        execFileSync('/usr/bin/pkill', ['-9', '-f', root], { stdio: 'ignore' })
      } catch {
        // 没有残留时 pkill 返回 1。
      }
      app.stdout?.destroy()
      app.stderr?.destroy()
      if (exited) {
        await Promise.race([exited, sleep(5_000)])
      }
      log(`关闭本次启动的 HiveWard 进程树 pid=${app.pid}；已确认=${terminated}`)
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('正式包冒烟只在 macOS 上运行')
  }
  if (!existsSync(appPath)) {
    throw new Error(`找不到 ${appPath}，先运行 pnpm build:mac:release`)
  }
  log(`应用 ${appPath}`)

  await runScenario({
    name: 'a 旧资料无活进程',
    prepare: async ({ source }) => {
      await writeLegacyProfile(source, await deadPid())
    },
    verify: async ({ source, target, notices }) => {
      const notice = profileNotice(notices)
      assert.equal(notice.status, 'migrated')
      await migratedFiles(source, target)
    }
  })

  await runScenario({
    name: 'b 旧资料有活进程',
    prepare: async ({ source }) => {
      const live = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
      await writeLegacyProfile(source, live.pid)
      return { live }
    },
    verify: async ({ source, target, notices }) => {
      const notice = profileNotice(notices)
      assert.equal(notice.status, 'deferred')
      assert.equal(notice.reason, 'migration_source_busy')
      assert.equal((await lstat(source)).isDirectory(), true, '暂缓时继续使用旧资料')
      // Electron 可能在选目录前建一个空壳；只要没有迁移标记和业务资料就不算选错目录。
      assert.equal(existsSync(join(target, marker)), false, '暂缓时不能发布新资料')
      assert.equal(existsSync(join(target, 'hiveward-data')), false, '暂缓时不能使用新资料')
      assert.ok(existsSync(join(source, 'opc-data', 'state.json')))
    }
  })

  await runScenario({
    name: 'c 只有 Local State 的空 HiveWard',
    prepare: async ({ source, target }) => {
      await writeLegacyProfile(source, await deadPid())
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'Local State'), '{"smoke":true}\n')
    },
    verify: async ({ source, target, support, notices }) => {
      const notice = profileNotice(notices)
      assert.equal(notice.status, 'migrated')
      await migratedFiles(source, target)
      assert.equal(existsSync(join(target, 'Local State')), false)
      const quarantined = (await readdir(support)).find((name) =>
        name.startsWith('HiveWard.incomplete-')
      )
      assert.ok(quarantined, 'Chromium 残留目录被隔离')
      assert.equal(
        await readFile(join(support, quarantined, 'Local State'), 'utf8'),
        '{"smoke":true}\n'
      )
    }
  })
}

await main()
