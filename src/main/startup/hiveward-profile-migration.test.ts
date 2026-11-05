import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  prepareHiveWardProfiles,
  hivewardMigrationNotices,
  hivewardMigrationPath
} from './hiveward-profile-migration'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp('/tmp/hiveward-startup-migration-')
  roots.push(home)
  vi.stubEnv('HOME', home)
  for (const key of ['HIVEWARD_E2E_USER_DATA_DIR', 'HIVEWARD_DEV_USER_DATA_PATH', 'HIVEWARD_USER_DATA_PATH']) {
    vi.stubEnv(key, undefined)
  }
  const appData = join(home, 'appData')
  const source = join(appData, 'OPC-Engine')
  await mkdir(join(source, 'opc-data'), { recursive: true, mode: 0o700 })
  const app = { isPackaged: true, getPath: () => appData, setName: vi.fn() }
  return { home, source, app, target: join(appData, 'HiveWard') }
}

describe('启动资料迁移接线', () => {
  it('迁移所有旧浏览器分区、业务身份和 home，同时保留旧密钥名称', async () => {
    const f = await fixture()
    await writeFile(
      join(f.source, 'opc-data', 'dispatches.json'),
      JSON.stringify([{ by: { id: 'opc-owner' }, prompt: 'opc-owner 原文' }])
    )
    for (const name of ['opc-cockpit', 'opc-google']) {
      await mkdir(join(f.source, 'Partitions', name), { recursive: true })
      await writeFile(join(f.source, 'Partitions', name, 'Cookies'), Buffer.from([12, 34, 56]))
    }
    await mkdir(join(f.home, '.opc-engine'))
    await writeFile(join(f.home, '.opc-engine', 'credentials'), 'opaque-encrypted-fixture')
    await prepareHiveWardProfiles(f.app)
    expect(hivewardMigrationPath()).toBe(f.target)
    expect(f.app.setName).toHaveBeenCalledWith('HiveWard')
    expect(
      JSON.parse(await readFile(join(f.target, 'hiveward-data', 'dispatches.json'), 'utf8'))
    ).toEqual([{ by: { id: 'hiveward-owner' }, prompt: 'opc-owner 原文' }])
    expect(await readFile(join(f.target, 'Partitions', 'hiveward-google', 'Cookies'))).toEqual(
      Buffer.from([12, 34, 56])
    )
    expect(await readFile(join(f.home, '.hiveward', 'credentials'), 'utf8')).toBe(
      'opaque-encrypted-fixture'
    )
    expect(hivewardMigrationNotices().every((item) => item.status === 'migrated')).toBe(true)
    await prepareHiveWardProfiles(f.app)
    expect(hivewardMigrationNotices().every((item) => item.status === 'current')).toBe(true)
  })

  it('发现活跃终端 PID 时不搬目录，继续连旧后台并报告暂缓', async () => {
    const f = await fixture()
    await mkdir(join(f.source, 'daemon'))
    await writeFile(join(f.source, 'daemon', 'daemon-v1.pid'), JSON.stringify({ pid: process.pid }))
    await prepareHiveWardProfiles(f.app)
    expect(hivewardMigrationPath()).toBe(f.source)
    expect(hivewardMigrationNotices()[0]).toMatchObject({
      status: 'deferred',
      reason: 'migration_source_busy'
    })
    expect(JSON.parse(await readFile(join(f.source, 'daemon', 'daemon-v1.pid'), 'utf8')).pid).toBe(
      process.pid
    )
  })
  it('ready 之前同步选定 userData，并且不碰 launchd 注册', async () => {
    const f = await fixture()
    const launchAgents = join(f.home, 'Library', 'LaunchAgents')
    await mkdir(launchAgents, { recursive: true })
    const oldPlist = join(launchAgents, 'local.opc.app.serve.plist')
    await writeFile(oldPlist, '<key>Label</key><string>local.opc.app.serve</string>')
    const returned = prepareHiveWardProfiles(f.app)
    expect(returned).toBeUndefined()
    expect(f.app.setName).toHaveBeenCalledWith('HiveWard')
    expect(hivewardMigrationPath()).toBe(f.target)
    expect(existsSync(join(f.target, 'hiveward-data'))).toBe(true)
    expect(await readFile(oldPlist, 'utf8')).toContain('local.opc.app.serve')
  })
  it('home 的关键 JSON 损坏时只回退 home，不误报迁移完成', async () => {
    const f = await fixture()
    await mkdir(join(f.home, '.opc-engine'))
    await writeFile(join(f.home, '.opc-engine', 'credentials.json'), '{interrupted')
    await prepareHiveWardProfiles(f.app)
    expect(hivewardMigrationPath()).toBe(f.target)
    expect(hivewardMigrationNotices()[1]).toMatchObject({
      status: 'failed',
      path: join(f.home, '.opc-engine')
    })
    expect(await readFile(join(f.home, '.opc-engine', 'credentials.json'), 'utf8')).toBe(
      '{interrupted'
    )
  })
})
