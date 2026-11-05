import assert from 'node:assert/strict'
import { spawnProcess } from '@hiveward/process-host'
import { once } from 'node:events'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { test } from 'node:test'
import {
  migrateHiveWardDirectory,
  migrateHiveWardDirectorySync
} from './hiveward-directory-migration.mjs'
import { HIVEWARD_MIGRATION_MARKER, readMigrationManifest } from './hiveward-migration-manifest.mjs'

async function fixture(t) {
  const root = await mkdtemp('/tmp/hiveward-directory-migration-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'OPC-Engine')
  const target = join(root, 'HiveWard')
  await mkdir(join(source, 'opc-data'), { recursive: true })
  await mkdir(join(source, 'Partitions', 'opc-alpha'), { recursive: true })
  await writeFile(join(source, 'opc-data', 'state.json'), '{"company":"测试"}')
  await writeFile(join(source, 'opc-runtime.json'), '{"fixture":true}')
  await writeFile(join(source, 'Partitions', 'opc-alpha', 'Cookies'), Buffer.from([0, 127, 255]))
  const options = {
    source,
    target,
    acquireSourceLease: async () => () => {},
    criticalJsonFiles: ['opc-data/state.json', 'opc-runtime.json'],
    renames: [
      ['opc-data', 'hiveward-data'],
      ['opc-runtime.json', 'hiveward-runtime.json'],
      ['Partitions/opc-alpha', 'Partitions/hiveward-alpha']
    ]
  }
  return {
    root,
    source,
    target,
    options,
    migrate: (overrides) => migrateHiveWardDirectory({ ...options, ...overrides }),
    migrateSync: (overrides) =>
      migrateHiveWardDirectorySync({
        ...options,
        acquireSourceLease: () => () => {},
        ...overrides
      })
  }
}

async function absent(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' })
}

async function staleSocket(path) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  await rename(path, `${path}.stale`)
  await new Promise((resolve) => server.close(resolve))
  await rename(`${path}.stale`, path)
}

async function marker(path) {
  return JSON.parse(await readFile(join(path, HIVEWARD_MIGRATION_MARKER), 'utf8'))
}

test('只有旧目录：完整复制、校验、改内部名称、发布标记，旧目录保留为备份', async (t) => {
  const f = await fixture(t)
  await chmod(join(f.source, 'opc-data', 'state.json'), 0o600)
  const original = await readMigrationManifest(f.source)
  let released = false
  const result = await f.migrate({
    acquireSourceLease: async () => () => {
      released = true
    }
  })
  assert.equal(result.status, 'migrated')
  assert.equal(result.path, f.target)
  assert.equal(result.files, 3)
  assert.equal(
    result.bytes,
    original.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
  )
  assert.match(result.backup, /OPC-Engine\.migrated-\d{4}-\d{2}-\d{2}/)
  await absent(f.source)
  assert.equal(released, true)
  assert.deepEqual(await readMigrationManifest(result.backup), original)
  assert.deepEqual(JSON.parse(await readFile(join(f.target, 'hiveward-data', 'state.json'))), {
    company: '测试'
  })
  assert.deepEqual(
    await readFile(join(f.target, 'Partitions', 'hiveward-alpha', 'Cookies')),
    Buffer.from([0, 127, 255])
  )
  if (process.platform !== 'win32') {
    assert.equal((await lstat(join(f.target, 'hiveward-data', 'state.json'))).mode & 0o777, 0o600)
  }
  assert.equal((await marker(f.target)).phase, 'complete')
  assert.deepEqual(
    await readdir(f.root),
    [f.target.split('/').at(-1), result.backup.split('/').at(-1)].sort()
  )
})

test('没人监听的残留 socket 不复制不进清单，其它文件照常迁移', async (t) => {
  const f = await fixture(t)
  const socket = join(f.source, 'daemon-v55.sock')
  await staleSocket(socket)
  assert.equal((await lstat(socket)).isSocket(), true)
  const result = await f.migrate()
  assert.equal(result.status, 'migrated')
  assert.equal(result.files, 3)
  await absent(join(f.target, 'daemon-v55.sock'))
  assert.equal((await lstat(join(result.backup, 'daemon-v55.sock'))).isSocket(), true)
  assert.deepEqual(JSON.parse(await readFile(join(f.target, 'hiveward-data', 'state.json'))), {
    company: '测试'
  })
  assert.deepEqual(
    await readFile(join(f.target, 'Partitions', 'hiveward-alpha', 'Cookies')),
    Buffer.from([0, 127, 255])
  )
})

test('仍有人监听的 socket 阻止迁移，不发布新目录', async (t) => {
  const f = await fixture(t)
  const socket = join(f.source, 'live.sock')
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const result = await f.migrate()
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'migration_special_file')
  assert.equal(result.path, f.source)
  await absent(f.target)
  assert.equal((await lstat(socket)).isSocket(), true)
  assert.deepEqual(JSON.parse(await readFile(join(f.source, 'opc-runtime.json'), 'utf8')), {
    fixture: true
  })
})

test('新旧都有：只使用已完成的新目录，不读取或覆盖旧资料', async (t) => {
  const f = await fixture(t)
  await f.migrate()
  await mkdir(f.source)
  await writeFile(join(f.source, '保留.txt'), '旧版新增')
  const result = await f.migrate({ acquireSourceLease: () => assert.fail('不应占用旧目录') })
  assert.equal(result.status, 'current')
  assert.equal(result.legacyPresent, true)
  assert.equal(await readFile(join(f.source, '保留.txt'), 'utf8'), '旧版新增')
})

test('重复启动幂等：不再复制，不重复备份，不改写完成标记', async (t) => {
  const f = await fixture(t)
  const first = await f.migrate()
  const before = await readFile(join(f.target, HIVEWARD_MIGRATION_MARKER), 'utf8')
  const result = await f.migrate({ copyTree: () => assert.fail('不应重复复制') })
  assert.equal(result.status, 'current')
  assert.equal(result.backup, first.backup)
  assert.equal(await readFile(join(f.target, HIVEWARD_MIGRATION_MARKER), 'utf8'), before)
  assert.equal((await readdir(f.root)).filter((name) => name.includes('.migrated-')).length, 1)
})

test('复制中断：只留下暂存，旧资料完整，重启可重新迁移', async (t) => {
  const f = await fixture(t)
  const before = await readMigrationManifest(f.source)
  const result = await f.migrate({
    copyTree: async (_source, staging) => {
      await mkdir(staging)
      await writeFile(join(staging, '半份数据'), '未完成')
      throw Object.assign(new Error('中断'), { code: 'EIO' })
    }
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.path, f.source)
  assert.equal(result.reason, 'EIO')
  assert.deepEqual(await readMigrationManifest(f.source), before)
  await absent(f.target)
  assert.equal((await f.migrate()).status, 'migrated')
})

test('同大小的复制损坏也会被哈希校验拒绝，并回退旧目录', async (t) => {
  const f = await fixture(t)
  const result = await f.migrate({
    copyTree: async (source, staging, options) => {
      await cp(source, staging, options)
      await writeFile(
        join(staging, 'Partitions', 'opc-alpha', 'Cookies'),
        Buffer.from([1, 127, 255])
      )
    }
  })
  assert.equal(result.reason, 'migration_verification_failed')
  assert.equal(result.path, f.source)
  await absent(f.target)
  assert.deepEqual(
    await readFile(join(f.source, 'Partitions', 'opc-alpha', 'Cookies')),
    Buffer.from([0, 127, 255])
  )
})

test('关键 JSON 无法解析：不发布，错误中不回显数据内容', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.source, 'opc-runtime.json'), '不要输出这段凭据')
  const result = await f.migrate()
  assert.equal(result.reason, 'migration_json_invalid')
  assert.equal(result.path, f.source)
  assert.equal(JSON.stringify(result).includes('不要输出'), false)
  await absent(f.target)
})

test('复制期间源文件变化：拒绝以不一致快照切换', async (t) => {
  const f = await fixture(t)
  const result = await f.migrate({
    copyTree: async (source, staging, options) => {
      await cp(source, staging, options)
      await writeFile(join(source, 'opc-runtime.json'), '{"fixture":false}')
    }
  })
  assert.equal(result.reason, 'migration_verification_failed')
  assert.equal(result.path, f.source)
  await absent(f.target)
})

test('没有完成标记的目标先隔离保留，再从旧目录重迁', async (t) => {
  const f = await fixture(t)
  await mkdir(f.target)
  await writeFile(join(f.target, '未完成.txt'), '保留以便排查')
  await writeFile(join(f.target, HIVEWARD_MIGRATION_MARKER), '{损坏标记')
  const result = await f.migrate()
  assert.equal(result.status, 'migrated')
  const quarantined = (await readdir(f.root)).filter((name) =>
    name.startsWith('HiveWard.incomplete-')
  )
  assert.equal(quarantined.length, 1)
  assert.equal(await readFile(join(f.root, quarantined[0], '未完成.txt'), 'utf8'), '保留以便排查')
  await absent(join(f.target, '未完成.txt'))
})

test('没有旧源时 Electron 先建的空目录按新装初始化', async (t) => {
  const f = await fixture(t)
  await rm(f.source, { recursive: true })
  await mkdir(f.target)
  const result = await f.migrate()
  assert.equal(result.status, 'initialized')
  assert.equal(result.path, f.target)
  assert.deepEqual(await readdir(f.target), [HIVEWARD_MIGRATION_MARKER])
})

test('没有旧源且有未完成数据：不能把半成品当成可用资料', async (t) => {
  const f = await fixture(t)
  await rm(f.source, { recursive: true })
  await mkdir(f.target)
  await writeFile(join(f.target, '未完成.txt'), '保留以便排查')
  const result = await f.migrate()
  assert.equal(result.reason, 'migration_incomplete_without_source')
  assert.equal(result.path, null)
  assert.equal(await readFile(join(f.target, '未完成.txt'), 'utf8'), '保留以便排查')
})

test('新装没有新旧目录：初始化并标记，第二次启动不会误判半成品', async (t) => {
  const f = await fixture(t)
  await rm(f.source, { recursive: true })
  assert.deepEqual(await f.migrate(), { status: 'initialized', path: f.target })
  assert.equal((await marker(f.target)).initialized, true)
  assert.equal((await f.migrate()).status, 'current')
  await absent(f.source)
})

test('旧目录仍被终端或服务使用时不复制、不改名、不发布', async (t) => {
  const f = await fixture(t)
  const before = await readMigrationManifest(f.source)
  const result = await f.migrate({
    acquireSourceLease: async () => null,
    copyTree: () => assert.fail('不应复制')
  })
  assert.equal(result.status, 'deferred')
  assert.equal(result.reason, 'migration_source_busy')
  assert.equal(result.path, f.source)
  assert.deepEqual(await readMigrationManifest(f.source), before)
  await absent(f.target)
})

test('同一目标并发启动最多一个迁移，另一实例沿用旧路径', async (t) => {
  const f = await fixture(t)
  let copying
  let resume
  const entered = new Promise((resolve) => {
    copying = resolve
  })
  const held = new Promise((resolve) => {
    resume = resolve
  })
  const first = f.migrate({
    copyTree: async (...args) => {
      copying()
      await held
      await cp(...args)
    }
  })
  await entered
  try {
    const second = await f.migrate()
    assert.equal(second.reason, 'migration_in_progress')
    assert.equal(second.path, f.source)
  } finally {
    resume()
  }
  assert.equal((await first).status, 'migrated')
})

test('正式目录已发布、备份已完成但标记未完成的崩溃窗口可恢复', async (t) => {
  const f = await fixture(t)
  const first = await f.migrate()
  const record = await marker(f.target)
  await writeFile(
    join(f.target, HIVEWARD_MIGRATION_MARKER),
    JSON.stringify({ ...record, phase: 'verified' })
  )
  const result = await f.migrate({ copyTree: () => assert.fail('不能重复复制') })
  assert.equal(result.recovered, true)
  assert.equal(result.backup, first.backup)
  assert.equal((await marker(f.target)).phase, 'complete')
})

test('已发布未完成且内容损坏：拒绝切换，旧备份恢复原路径', async (t) => {
  const f = await fixture(t)
  const first = await f.migrate()
  const record = await marker(f.target)
  await writeFile(
    join(f.target, HIVEWARD_MIGRATION_MARKER),
    JSON.stringify({ ...record, phase: 'verified' })
  )
  await writeFile(join(f.target, 'hiveward-runtime.json'), '{"changed":true}')
  const result = await f.migrate()
  assert.equal(result.reason, 'migration_verification_failed')
  assert.equal(result.path, f.source)
  await absent(first.backup)
  assert.equal(await readFile(join(f.source, 'opc-runtime.json'), 'utf8'), '{"fixture":true}')
})

test('真实子进程复制中退出，遗留锁不会阻止下一次启动重迁', async (t) => {
  const f = await fixture(t)
  const script = join(f.root, 'interrupt.mjs')
  const moduleUrl = new URL('./hiveward-directory-migration.mjs', import.meta.url).href
  await writeFile(
    script,
    `
    import { mkdir, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { migrateHiveWardDirectory } from ${JSON.stringify(moduleUrl)}
    await migrateHiveWardDirectory({
      source: process.argv[2], target: process.argv[3], acquireSourceLease: async () => () => {},
      copyTree: async (_source, staging) => {
        await mkdir(staging)
        await writeFile(join(staging, '中断文件'), '半份')
        process.exit(29)
      }
    })
  `
  )
  const child = spawnProcess({
    program: process.execPath,
    args: [script, f.source, f.target],
    env: { HIVEWARD_BACKGROUND_LAUNCH: '1', TMPDIR: '/tmp' },
    stdio: 'ignore'
  })
  t.after(() => {
    if (child.exitCode === null) {
      child.kill()
    }
  })
  assert.deepEqual(await once(child, 'exit'), [29, null])
  assert.equal((await f.migrate()).status, 'migrated')
})

test('符号链接按原样复制，不跟随读取；空目录和私有权限保留', async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.source, '空目录'))
  await symlink('opc-runtime.json', join(f.source, '旧指针'))
  const result = await f.migrate({ renames: [] })
  assert.equal(result.status, 'migrated')
  assert.equal(await readlink(join(f.target, '旧指针')), 'opc-runtime.json')
  assert.deepEqual(await readdir(join(f.target, '空目录')), [])
})

test('迁移 .opc-engine 时同样保留 hook 和终端策略', async (t) => {
  const f = await fixture(t)
  const source = join(f.root, '.opc-engine')
  const target = join(f.root, '.hiveward')
  await rename(f.source, source)
  await mkdir(join(source, 'agent-hooks', 'hiveward'), { recursive: true })
  await writeFile(join(source, 'agent-hooks', 'hiveward', 'hook.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(source, 'agent-hooks', 'hiveward', 'hook.sh'), 0o700)
  const result = await f.migrate({ source, target, renames: [] })
  assert.equal(result.status, 'migrated')
  assert.equal(
    await readFile(join(target, 'agent-hooks', 'hiveward', 'hook.sh'), 'utf8'),
    '#!/bin/sh\nexit 0\n'
  )
  assert.equal((await lstat(result.backup)).isDirectory(), true)
})

test('同一旧目录中已有新名称时不覆盖，保留源目录回退', async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.source, 'hiveward-data'))
  await writeFile(join(f.source, 'hiveward-data', '已有'), '保留')
  const result = await f.migrate()
  assert.equal(result.reason, 'migration_layout_conflict')
  assert.equal(result.path, f.source)
  assert.equal(await readFile(join(f.source, 'hiveward-data', '已有'), 'utf8'), '保留')
})

test('路径边界：拒绝重叠根目录、缺少使用权检查、目录外改名和符号链接目标', async (t) => {
  const f = await fixture(t)
  for (const target of [f.source, join(f.source, '子目录'), f.root]) {
    await assert.rejects(f.migrate({ target }), { code: 'migration_overlapping_roots' })
  }
  await assert.rejects(f.migrate({ source: 'relative' }), {
    code: 'migration_absolute_paths_required'
  })
  await assert.rejects(f.migrate({ acquireSourceLease: undefined }), {
    code: 'migration_source_lease_required'
  })
  assert.equal(
    (await f.migrate({ renames: [['opc-data', '../不该创建']] })).reason,
    'migration_path_outside_root'
  )
  await absent(join(f.root, '不该创建'))
  await symlink(f.source, f.target)
  assert.equal((await f.migrate()).reason, 'migration_target_not_directory')
  assert.equal(await readlink(f.target), f.source)
})

test('父目录符号链接也不能绕过重叠根检查或关键 JSON 边界', async (t) => {
  const f = await fixture(t)
  const alias = join(f.root, '旧源别名')
  await symlink(f.source, alias)
  assert.equal(
    (await f.migrate({ target: join(alias, '不应创建') })).reason,
    'migration_overlapping_roots'
  )
  await absent(join(f.source, '不应创建'))
  await symlink(f.source, join(f.source, '循环目录'))
  const result = await f.migrate({ criticalJsonFiles: ['循环目录/opc-runtime.json'] })
  assert.equal(result.reason, 'migration_linked_parent')
  assert.equal(result.path, f.source)
})

test('目录内部的符号链接不能让布局改名触碰外部文件', async (t) => {
  const f = await fixture(t)
  const external = join(f.root, '目录之外')
  await mkdir(external)
  await writeFile(join(external, '不要动'), '保留')
  await symlink(external, join(f.source, '外链'))
  const result = await f.migrate({ renames: [['外链/不要动', '不应搬入']] })
  assert.equal(result.reason, 'migration_linked_parent')
  assert.equal(await readFile(join(external, '不要动'), 'utf8'), '保留')
  await absent(f.target)
})

test('合法 JSON 但无有效完成状态的标记也必须重新迁移', async (t) => {
  for (const state of ['null', '{"version":1,"phase":"complete"}']) {
    const f = await fixture(t)
    await mkdir(f.target)
    await writeFile(join(f.target, HIVEWARD_MIGRATION_MARKER), state)
    assert.equal((await f.migrate()).status, 'migrated')
    assert.equal((await marker(f.target)).phase, 'complete')
  }
})

test('同步迁移在调用栈内完成复制、校验和发布', async (t) => {
  const f = await fixture(t)
  let released = false
  const result = f.migrateSync({
    acquireSourceLease: () => () => {
      released = true
    }
  })
  assert.equal(result.status, 'migrated')
  assert.equal(result.path, f.target)
  assert.equal(released, true)
  await absent(f.source)
  assert.equal((await marker(f.target)).phase, 'complete')
  assert.deepEqual(JSON.parse(await readFile(join(f.target, 'hiveward-data', 'state.json'))), {
    company: '测试'
  })
})

test('同步迁移遇到活动的旧资料返回暂缓，不复制也不发布', async (t) => {
  const f = await fixture(t)
  const result = f.migrateSync({ acquireSourceLease: () => null })
  assert.equal(result.status, 'deferred')
  assert.equal(result.reason, 'migration_source_busy')
  assert.equal(result.path, f.source)
  await absent(f.target)
})

test('只有 Chromium Local State 的残留目录可安全重迁', async (t) => {
  const f = await fixture(t)
  await mkdir(f.target)
  await writeFile(join(f.target, 'Local State'), '{"chromium":true}')
  const result = await f.migrate()
  assert.equal(result.status, 'migrated')
  assert.equal((await marker(f.target)).phase, 'complete')
  const quarantined = (await readdir(f.root)).filter((name) =>
    name.startsWith('HiveWard.incomplete-')
  )
  assert.equal(quarantined.length, 1)
  assert.equal(
    await readFile(join(f.root, quarantined[0], 'Local State'), 'utf8'),
    '{"chromium":true}'
  )
  await absent(join(f.target, 'Local State'))
})

test('没有旧资料时只有 Local State 的目录按新装初始化，不误报半成品', async (t) => {
  const f = await fixture(t)
  await rm(f.source, { recursive: true })
  await mkdir(f.target)
  await writeFile(join(f.target, 'Local State'), '{"chromium":true}')
  const result = f.migrateSync()
  assert.equal(result.status, 'initialized')
  assert.equal(result.path, f.target)
  assert.deepEqual((await readdir(f.target)).sort(), [HIVEWARD_MIGRATION_MARKER])
  assert.equal((await marker(f.target)).initialized, true)
})
