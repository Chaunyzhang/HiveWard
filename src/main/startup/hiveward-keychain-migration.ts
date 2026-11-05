import { execSecurityCommand, isKeychainNotFoundError } from '../macos-keychain/generic-password'

type KeychainCommandResult = { stdout: string; stderr: string }
type KeychainCommandRunner = (args: string[], timeoutMs?: number) => Promise<KeychainCommandResult>

type KeychainIdentity = {
  use: 'new' | 'legacy'
  appName: string
}

const PROMPTABLE_READ_TIMEOUT_MS = 60_000

/** 打包后的可执行文件位于 <App>.app/Contents/MacOS/；返回 .app 供 -T 直接信任。 */
function appBundlePath(execPath: string | undefined): string | null {
  if (!execPath) {
    return null
  }
  const marker = '.app/Contents/MacOS/'
  const index = execPath.indexOf(marker)
  return index === -1 ? null : execPath.slice(0, index + '.app'.length)
}

function identityFor(dev: boolean, legacy: boolean): { service: string; account: string } {
  const base = legacy ? (dev ? 'OPC Engine Dev' : 'OPC Engine') : dev ? 'HiveWard Dev' : 'HiveWard'
  return { service: `${base} Safe Storage`, account: `${base} Key` }
}

async function itemExists(
  run: KeychainCommandRunner,
  identity: { service: string; account: string }
): Promise<boolean> {
  try {
    await run(['find-generic-password', '-s', identity.service, '-a', identity.account])
    return true
  } catch (error) {
    if (isKeychainNotFoundError(error)) {
      return false
    }
    throw error
  }
}

/**
 * macOS 只在新条目缺失时把旧钥匙串密钥原样搬到新名；失败本次继续用旧名，下次启动再试。
 * Windows 使用 DPAPI，与钥匙串名称无关；Linux 不发版。
 */
export async function adoptHiveWardKeychainIdentity(options: {
  platform: NodeJS.Platform
  dev: boolean
  execPath?: string
  run?: KeychainCommandRunner
}): Promise<KeychainIdentity> {
  const next = identityFor(options.dev, false)
  const legacy = identityFor(options.dev, true)
  const newName = options.dev ? 'HiveWard Dev' : 'HiveWard'
  const legacyName = options.dev ? 'OPC Engine Dev' : 'OPC Engine'
  if (options.platform !== 'darwin') {
    return { use: 'new', appName: newName }
  }
  const run = options.run ?? execSecurityCommand
  try {
    if (await itemExists(run, next)) {
      return { use: 'new', appName: newName }
    }
    if (!(await itemExists(run, legacy))) {
      return { use: 'new', appName: newName }
    }
    const { stdout } = await run(
      ['find-generic-password', '-s', legacy.service, '-a', legacy.account, '-w'],
      PROMPTABLE_READ_TIMEOUT_MS
    )
    // security 会在密钥末尾带一个换行；只去掉这一个，不改密钥字节。
    const secret = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
    const trust = options.dev ? null : appBundlePath(options.execPath)
    await run([
      'add-generic-password',
      '-s',
      next.service,
      '-a',
      next.account,
      ...(trust ? ['-T', trust] : []),
      '-w',
      secret
    ])
    return { use: 'new', appName: newName }
  } catch {
    return { use: 'legacy', appName: legacyName }
  }
}
