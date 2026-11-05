import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { migrateHiveWardLaunchAgents } from './hiveward-launch-agent-migration'

describe('launchd 身份迁移', () => {
  it('旧服务确认退出后才启动新服务，原 plist 备份保留，重复启动不双跑', async () => {
    const directory = await mkdtemp('/tmp/hiveward-launch-agents-')
    try {
      const old = 'local.opc.app.serve'
      await writeFile(
        join(directory, `${old}.plist`),
        `<key>Label</key><string>${old}</string><string>/Applications/HiveWard.app/Contents/Resources/opc/server/hiwd.mjs</string>`
      )
      const calls: string[][] = []
      const options = {
        directory,
        uid: 123,
        sourceData: '/old',
        selectedData: '/new',
        run: async (args: string[]) => {
          calls.push(args)
          return { code: args[0] === 'print' ? 113 : 0 }
        }
      }
      await migrateHiveWardLaunchAgents(options)
      expect(calls.map((args) => args[0])).toEqual(['bootout', 'print', 'print', 'bootstrap'])
      expect(calls[1][1]).toBe('gui/123/local.opc.app.serve')
      expect(calls[3][2]).toBe(join(directory, 'app.hiveward.serve.plist'))
      expect(await readFile(calls[3][2], 'utf8')).toContain('/Resources/hiveward/server/')
      expect(
        (await readdir(directory)).some((name) => name.startsWith(`${old}.plist.migrated-`))
      ).toBe(true)
      await migrateHiveWardLaunchAgents(options)
      expect(calls).toHaveLength(4)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('旧服务存活或状态不明时绝不 bootstrap 新服务，也不操作 Orca 注册', async () => {
    const directory = await mkdtemp('/tmp/hiveward-launch-agents-')
    try {
      await mkdir(join(directory, 'ignored'))
      await writeFile(join(directory, 'com.stablyai.orca.serve.plist'), '不修改')
      await writeFile(
        join(directory, 'local.opc.app.serve.plist'),
        '<key>Label</key><string>local.opc.app.serve</string>'
      )
      const calls: string[][] = []
      await expect(
        migrateHiveWardLaunchAgents({
          directory,
          uid: 123,
          sourceData: '/old',
          selectedData: '/new',
          run: async (args) => {
            calls.push(args)
            return { code: 0 }
          }
        })
      ).rejects.toThrow('exit could not be verified')
      expect(calls.some((args) => args[0] === 'bootstrap')).toBe(false)
      expect(await readFile(join(directory, 'com.stablyai.orca.serve.plist'), 'utf8')).toBe(
        '不修改'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('既有新 plist 的实际 Label 指向 HiveWard 时不卸载、不启动任何服务', async () => {
    const directory = await mkdtemp('/tmp/hiveward-launch-agents-')
    try {
      await writeFile(
        join(directory, 'local.opc.app.serve.plist'),
        '<key>Label</key><string>local.opc.app.serve</string>'
      )
      await writeFile(
        join(directory, 'app.hiveward.serve.plist'),
        '<key>Label</key><string>app.hiveward.dev.serve</string>'
      )
      const calls: string[][] = []
      await expect(
        migrateHiveWardLaunchAgents({
          directory,
          uid: 123,
          sourceData: '/old',
          selectedData: '/new',
          run: async (args) => {
            calls.push(args)
            return { code: 0 }
          }
        })
      ).rejects.toThrow('identity mismatch')
      expect(calls).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
