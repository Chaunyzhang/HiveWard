import { mkdtemp, writeFile, readdir, lstat, realpath, access, rm } from 'node:fs/promises'
import { join, dirname, posix } from 'node:path'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { runProcess, spawnProcess } from '@hiveward/process-host'

async function runInstallerCommand(spec: { program: string; args: string[] }) {
  const result = await runProcess({
    ...spec,
    timeoutMs: 120_000,
    maxOutputBytes: 4 * 1024 * 1024,
    killOnOutputLimit: true
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`更新准备失败：${spec.program}`)
  }
  return result
}

// 路径只通过 argv 传入；退出后先准备同卷新包，再用重命名替换，失败恢复旧包。
export const MAC_INSTALL_SCRIPT = `#!/bin/sh
set -eu
pid="$1"
source_app="$2"
target_app="$3"
work="$4"
exec >>"$work/install.log" 2>&1
count=0
while kill -0 "$pid" 2>/dev/null; do
  count=$((count + 1))
  [ "$count" -lt 120 ] || exit 1
  sleep 1
done
parent=$(dirname "$target_app")
stage=""
backup=""
completed=0
restore() {
  if [ -n "$backup" ] && [ -d "$backup" ] && [ ! -e "$target_app" ]; then
    mv "$backup" "$target_app"
  fi
  if [ "$completed" -ne 1 ] && [ -d "$target_app" ]; then
    /usr/bin/open "$target_app" || true
  fi
}
trap restore EXIT
trap 'exit 1' HUP INT TERM
stage=$(mktemp -d "$parent/.hiveward-update.XXXXXX")
backup="$stage/previous.app"
/usr/bin/ditto "$source_app" "$stage/HiveWard.app"
mv "$target_app" "$backup"
mv "$stage/HiveWard.app" "$target_app"
if /usr/bin/open "$target_app"; then
  completed=1
  rm -rf "$stage"
  rm -rf "$source_app"
else
  mv "$target_app" "$stage/failed.app"
  mv "$backup" "$target_app"
  exit 1
fi
`

export async function prepareMacUpdate(
  zip: string,
  version: string,
  bundleId: string
): Promise<{ app: string; directory: string }> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hiveward-update-')))
  try {
    const listing = await runInstallerCommand({ program: '/usr/bin/unzip', args: ['-Z1', zip] })
    const attributes = await runInstallerCommand({
      program: '/usr/bin/unzip',
      args: ['-Z', '-l', zip]
    })
    const entries = listing.stdout.split('\n').filter(Boolean)
    for (const entry of entries) {
      if (
        entry.startsWith('/') ||
        entry.includes('\\') ||
        entry.split('/').includes('..') ||
        (!entry.startsWith('HiveWard.app/') && !entry.startsWith('__MACOSX/'))
      ) {
        throw new Error('更新压缩包包含不安全路径')
      }
    }
    // Framework 的相对链接可保留，解压前拒绝所有指向 App 之外的链接。
    for (const line of attributes.stdout.split('\n').filter((entry) => entry.startsWith('l'))) {
      const entry = [...entries]
        .sort((a, b) => b.length - a.length)
        .find((name) => line.endsWith(` ${name}`))
      if (!entry) {
        throw new Error('无法验证更新压缩包链接')
      }
      const link = await runInstallerCommand({
        program: '/usr/bin/unzip',
        args: ['-p', zip, entry]
      })
      const target = link.stdout
      const resolved = posix.normalize(posix.join(posix.dirname(entry), target))
      if (
        target.startsWith('/') ||
        target.includes('\\') ||
        !resolved.startsWith('HiveWard.app/')
      ) {
        throw new Error('更新压缩包包含越界链接')
      }
    }
    await runInstallerCommand({ program: '/usr/bin/ditto', args: ['-x', '-k', zip, directory] })
    const apps = (await readdir(directory)).filter((name) => name.endsWith('.app'))
    if (apps.length !== 1 || apps[0] !== 'HiveWard.app') {
      throw new Error('更新压缩包不是 HiveWard')
    }
    const app = join(directory, apps[0])
    if ((await lstat(app)).isSymbolicLink() || (await realpath(app)) !== app) {
      throw new Error('更新应用路径不安全')
    }
    const plist = join(app, 'Contents/Info.plist')
    for (const [key, expected] of [
      ['CFBundleIdentifier', bundleId],
      ['CFBundleShortVersionString', version]
    ]) {
      const result = await runInstallerCommand({
        program: '/usr/libexec/PlistBuddy',
        args: ['-c', `Print :${key}`, plist]
      })
      if (result.stdout.trim() !== expected) {
        throw new Error('更新应用身份或版本不一致')
      }
    }
    await runInstallerCommand({
      program: '/usr/bin/codesign',
      args: ['--verify', '--deep', '--strict', app]
    })
    return { app, directory }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function launchMacInstaller(
  source: string,
  directory: string,
  executable: string
): Promise<void> {
  const target = dirname(dirname(dirname(executable)))
  if (target !== '/Applications/HiveWard.app') {
    throw new Error('请先将 HiveWard 放入 /Applications')
  }
  await access(dirname(target), constants.W_OK)
  const script = join(directory, 'install.sh')
  await writeFile(script, MAC_INSTALL_SCRIPT, { mode: 0o700 })
  const child = spawnProcess({
    program: '/bin/sh',
    args: [script, String(process.pid), source, target, directory],
    detached: true,
    stdio: 'ignore'
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}
