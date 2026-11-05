import { migrateHiveWardLaunchAgents } from './hiveward-launch-agent-migration'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  migrateHiveWardDirectorySync,
  type HiveWardDirectoryMigration
} from '../hiveward-directory-migration.mjs'
import { acquireHivewarddInstanceLock } from '../hivewardd/hivewardd-instance-lock'
import { hivewardProduct } from '../../shared/hiveward-policy'
import { migrateOwnerIdentity } from './hiveward-owner-identity-migration'

let selectedPath: string | null = null
let notices: HiveWardDirectoryMigration[] = []
let serveMigration: { source: string; selectedData: string } | null = null

export const hivewardMigrationPath = (): string | null => selectedPath
export const hivewardMigrationNotices = (): HiveWardDirectoryMigration[] => notices

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined
  }
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function compatibilityAliasesSync(
  result: HiveWardDirectoryMigration,
  source: string,
  layout: string[][]
): void {
  if (!['migrated', 'current'].includes(result.status) || !result.path) {
    return
  }
  let existing
  try {
    existing = lstatSync(source)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error
    }
    existing = null
  }
  if (existing && !existing.isSymbolicLink()) {
    return
  }
  if (!existing) {
    symlinkSync(result.path, source, process.platform === 'win32' ? 'junction' : 'dir')
  }
  for (const [oldName, newName] of layout) {
    const target = join(result.path, newName)
    if (!existsSync(target) || existsSync(join(result.path, oldName))) {
      continue
    }
    const stat = lstatSync(target)
    symlinkSync(
      target,
      join(result.path, oldName),
      stat.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'
    )
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

function directoryHasLiveProcessesSync(root: string): boolean {
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name)
    if (item.isDirectory() && ['daemon', 'profiles'].includes(item.name)) {
      if (directoryHasLiveProcessesSync(path)) {
        return true
      }
    } else if (item.isDirectory() && root.endsWith('profiles')) {
      if (directoryHasLiveProcessesSync(path)) {
        return true
      }
    } else if (
      item.name.endsWith('.pid') ||
      ['opc-runtime.json', 'hiveward-runtime.json', 'hivewardd.lock', 'orcad.lock'].includes(item.name)
    ) {
      try {
        const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
        const pid =
          typeof record === 'number'
            ? record
            : record && typeof record === 'object' && 'pid' in record
              ? record.pid
              : null
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || alive(pid)) {
          return true
        }
      } catch {
        return true
      }
    }
  }
  return false
}

function userDataLayoutSync(root: string): {
  renames: string[][]
  criticalJsonFiles: string[]
} {
  const renames = [
    ['opc-data', 'hiveward-data'],
    ['opc-runtime.json', 'hiveward-runtime.json']
  ]
  const criticalJsonFiles: string[] = []
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (item.isFile() && item.name.endsWith('.json')) {
      criticalJsonFiles.push(item.name)
    }
  }
  for (const dir of ['opc-data', 'hiveward-data']) {
    if (!existsSync(join(root, dir))) {
      continue
    }
    for (const item of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (item.isFile() && item.name.endsWith('.json')) {
        criticalJsonFiles.push(`${dir}/${item.name}`)
      }
    }
  }
  if (existsSync(join(root, 'Partitions'))) {
    for (const name of readdirSync(join(root, 'Partitions'))) {
      if (name.startsWith('opc-')) {
        renames.push([`Partitions/${name}`, `Partitions/hiveward-${name.slice(4)}`])
      }
    }
  }
  return { renames, criticalJsonFiles }
}

function homeJsonFilesSync(root: string, prefix = ''): string[] {
  const files: string[] = []
  for (const item of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const name = join(prefix, item.name)
    if (item.isDirectory()) {
      files.push(...homeJsonFilesSync(root, name))
    } else if (item.isFile() && item.name.endsWith('.json')) {
      files.push(name)
    }
  }
  return files
}

function transformProfileSync(root: string, files: string[]): void {
  // 复制品中的运行时锁不属于持久化资料，不能让新实例继承迁移进程的锁。
  for (const name of ['hivewardd.lock', 'orcad.lock']) {
    try {
      unlinkSync(join(root, name))
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error
      }
    }
  }
  for (const name of files.filter((name) => /^(opc-data|hiveward-data)\//.test(name))) {
    const path = join(root, name)
    const raw = readFileSync(path, 'utf8')
    if (!raw.includes('opc-owner')) {
      continue
    }
    const normalized = migrateOwnerIdentity(JSON.parse(raw))
    writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`)
  }
}

// 资料目录里旧 Orca 名字的一次性搬家：旧名存在且新名不存在才改名，绝不覆盖新数据。
const LEGACY_RUNTIME_NAMES: readonly (readonly [string, string])[] = [
  ['orca-profile-index.json', 'hiveward-profile-index.json'],
  ['orca-data.json', 'hiveward-data.json'],
  ['orca-runtime.json', 'hiveward-runtime.json'],
  ['orca-wsl-host-deployments.json', 'hiveward-wsl-host-deployments.json'],
  ['orca-e2ee-keypair.json', 'hiveward-e2ee-keypair.json'],
  ['orcad-artifacts', 'hivewardd-artifacts'],
  ['orcad.lock', 'hivewardd.lock'],
  ['orca-browser-screenshots', 'hiveward-browser-screenshots'],
  ['orca-computer-use', 'hiveward-computer-use']
]

function renameLegacyRuntimeNamesSync(root: string): void {
  for (const [oldName, newName] of LEGACY_RUNTIME_NAMES) {
    const from = join(root, oldName)
    const to = join(root, newName)
    if (!existsSync(from) || existsSync(to)) {
      continue
    }
    try {
      renameSync(from, to)
    } catch (error) {
      console.warn(`[hiveward] legacy runtime rename deferred: ${oldName}`, error)
    }
  }
  const profiles = join(root, 'profiles')
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) {
      renameLegacyRuntimeNamesSync(join(profiles, name))
    }
  }
}

type MigrationApp = {
  isPackaged: boolean
  getPath(name: 'appData'): string
  setName(name: string): void
}

// Electron ready 之前必须同步完成：userData 一旦被 Chromium 抢先落盘，后续迁移就会选错目录。
export function prepareHiveWardProfiles(app: MigrationApp): void {
  selectedPath = null
  notices = []
  serveMigration = null
  const dev = !app.isPackaged
  if (process.env.HIVEWARD_E2E_USER_DATA_DIR) {
    return
  }
  // 加密查找键由早期 app name 决定，保留已使用的名称。
  app.setName(dev ? `${hivewardProduct.keychainName} Dev` : hivewardProduct.keychainName)
  if (process.env.HIVEWARD_E2E_USER_DATA_DIR || process.env.HIVEWARD_DEV_USER_DATA_PATH) {
    return
  }
  const source = join(app.getPath('appData'), dev ? 'OPC-Engine-Dev' : 'OPC-Engine')
  const target = join(
    app.getPath('appData'),
    dev ? hivewardProduct.devDataDirectory : hivewardProduct.dataDirectory
  )
  let result: HiveWardDirectoryMigration
  try {
    const layout = existsSync(source)
      ? userDataLayoutSync(source)
      : { renames: [], criticalJsonFiles: [] }
    result = migrateHiveWardDirectorySync({
      source,
      target,
      ...layout,
      acquireSourceLease: (root) => {
        if (directoryHasLiveProcessesSync(root)) {
          return null
        }
        try {
          const lock = acquireHivewarddInstanceLock(root, { role: 'desktop' })
          return () => lock.release()
        } catch (error) {
          // 锁被占用或无法判定时继续用旧资料，不阻断启动。
          console.warn('[hiveward] profile migration deferred:', error)
          return null
        }
      },
      transformStaging: (root) => transformProfileSync(root, layout.criticalJsonFiles)
    })
  } catch (error) {
    console.warn('[hiveward] profile migration failed before admission:', error)
    result = {
      status: 'failed',
      path: existsSync(source) ? source : null,
      reason: 'migration_prepare_failed'
    }
  }
  notices = [result]
  selectedPath = result.path ?? (existsSync(source) ? source : existsSync(target) ? target : null)
  if (selectedPath) {
    renameLegacyRuntimeNamesSync(selectedPath)
  }
  if (['migrated', 'current'].includes(result.status)) {
    try {
      compatibilityAliasesSync(result, source, [
        ['opc-data', 'hiveward-data'],
        ['opc-runtime.json', 'hiveward-runtime.json']
      ])
    } catch {
      notices.push({ status: 'failed', path: selectedPath, reason: 'migration_alias_failed' })
    }
  }
  console.info(
    '[hiveward] profile migration',
    result.status,
    result.reason ?? '',
    result.legacyPresent ? 'legacy directory retained' : ''
  )
  const home = homedir()
  const homeSource = join(home, '.opc-engine')
  let homeResult: HiveWardDirectoryMigration
  try {
    homeResult = migrateHiveWardDirectorySync({
      criticalJsonFiles: existsSync(homeSource) ? homeJsonFilesSync(homeSource) : [],
      source: homeSource,
      target: join(home, '.hiveward'),
      // 资料目录暂缓（终端后台还在跑）时，它们的 hook 也还在用 ~/.opc-engine，一起暂缓。
      acquireSourceLease: () =>
        result.status === 'failed' || result.status === 'deferred' ? null : () => {},
      transformStaging: (root) => {
        // 复制品不继承 hook 安装锁，避免新实例以为有别的安装在进行。
        try {
          unlinkSync(join(root, 'managed-hook-install.lock'))
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {
            throw error
          }
        }
      }
    })
    compatibilityAliasesSync(homeResult, homeSource, [])
  } catch {
    homeResult = {
      status: 'failed',
      path: homeSource,
      reason: 'migration_home_busy'
    }
  }
  notices.push(homeResult)
  if (process.platform === 'darwin' && selectedPath) {
    serveMigration = { source, selectedData: selectedPath }
  }
}

/** launchd 切换不影响 userData 选择，等 Electron ready 之后再做，成功与否都不阻断启动。 */
export async function migrateHiveWardLaunchAgentsAfterReady(): Promise<void> {
  if (process.platform !== 'darwin' || !serveMigration) {
    return
  }
  try {
    await migrateHiveWardLaunchAgents({
      directory: join(homedir(), 'Library', 'LaunchAgents'),
      uid: process.getuid?.() ?? 0,
      sourceData: serveMigration.source,
      selectedData: serveMigration.selectedData
    })
  } catch {
    notices.push({
      status: 'failed',
      path: serveMigration.selectedData,
      reason: 'migration_serve_failed'
    })
    console.warn('[hiveward] serve migration deferred; original registration retained')
  }
}
