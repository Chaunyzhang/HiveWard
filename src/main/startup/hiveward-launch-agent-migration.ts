import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '@hiveward/process-host'

type ManagerResult = { code: number | null }
type LaunchAgentMigrationOptions = {
  directory: string
  uid: number
  sourceData: string
  selectedData: string
  run?: (args: string[]) => Promise<ManagerResult>
}

function assertLaunchAgentLabel(raw: string, expected: string): void {
  const labels = [...raw.matchAll(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/g)]
  if (labels.length !== 1 || labels[0][1] !== expected) {
    throw new Error('HiveWard launch agent identity mismatch')
  }
}

export async function migrateHiveWardLaunchAgents(
  options: LaunchAgentMigrationOptions
): Promise<void> {
  if (!existsSync(options.directory)) {
    return
  }
  const run =
    options.run ??
    ((args: string[]) => runProcess({ program: '/bin/launchctl', args, timeoutMs: 20_000 }))
  const domain = `gui/${options.uid}`
  for (const file of await readdir(options.directory)) {
    if (!/^local\.opc\.app\.serve(?:\.[\w.-]+)?\.plist$/.test(file)) {
      continue
    }
    const oldLabel = file.slice(0, -6)
    const newLabel = oldLabel.replace('local.opc.app', 'app.hiveward')
    const oldPath = join(options.directory, file)
    const newPath = join(options.directory, `${newLabel}.plist`)
    const raw = await readFile(oldPath, 'utf8')
    assertLaunchAgentLabel(raw, oldLabel)
    if (!existsSync(newPath)) {
      const content = raw
        .replaceAll('local.opc.app', 'app.hiveward')
        .replaceAll('/Resources/opc/', '/Resources/hiveward/')
        .replaceAll(options.sourceData, options.selectedData)
      await writeFile(newPath, content, { flag: 'wx', mode: 0o600 })
    }
    assertLaunchAgentLabel(await readFile(newPath, 'utf8'), newLabel)
    await run(['bootout', `${domain}/${oldLabel}`])
    if ((await run(['print', `${domain}/${oldLabel}`])).code !== 113) {
      throw new Error('HiveWard old serve exit could not be verified; new serve was not started')
    }
    const current = await run(['print', `${domain}/${newLabel}`])
    if (current.code !== 0) {
      if (current.code !== 113) {
        throw new Error('HiveWard new serve state could not be verified')
      }
      if ((await run(['bootstrap', domain, newPath])).code !== 0) {
        // 新服务可能已被部分加载，只有证明已退出后才能恢复旧服务。
        await run(['bootout', `${domain}/${newLabel}`])
        if ((await run(['print', `${domain}/${newLabel}`])).code === 113) {
          await run(['bootstrap', domain, oldPath])
        }
        throw new Error('HiveWard new serve failed; old registration retained for recovery')
      }
    }
    await rename(oldPath, `${oldPath}.migrated-${Date.now()}`)
  }
}
