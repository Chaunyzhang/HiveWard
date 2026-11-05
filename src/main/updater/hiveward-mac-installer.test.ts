import { afterEach, expect, it } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@hiveward/process-host'
import { MAC_INSTALL_SCRIPT, launchMacInstaller } from './hiveward-mac-installer'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function installFixture(openResult = 0) {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-install-test-'))
  directories.push(root)
  const old = join(root, 'Applications with spaces', 'HiveWard.app')
  const fresh = join(root, 'new bundle', 'HiveWard.app')
  await mkdir(old, { recursive: true })
  await mkdir(fresh, { recursive: true })
  await writeFile(join(old, 'version'), '1.0.0')
  await writeFile(join(fresh, 'version'), '1.1.0')
  const copier = join(root, 'ditto-fixture')
  const opener = join(root, 'open-fixture')
  await writeFile(copier, '#!/bin/sh\ncp -R "$1" "$2"\n', { mode: 0o700 })
  await writeFile(opener, `#!/bin/sh\nexit ${openResult}\n`, { mode: 0o700 })
  const script = join(root, 'install.sh')
  const safe = MAC_INSTALL_SCRIPT.replace('/usr/bin/ditto', `"${copier}"`).replaceAll(
    '/usr/bin/open',
    `"${opener}"`
  )
  await writeFile(script, safe)
  return { root, old, fresh, script }
}
it.skipIf(process.platform === 'win32')(
  '独立安装脚本在同卷准备后替换，路径中的空格不会变成命令',
  async () => {
    const fixture = await installFixture()
    await runProcess({
      program: '/bin/sh',
      args: [fixture.script, '999999999', fixture.fresh, fixture.old, fixture.root]
    })
    expect(await readFile(join(fixture.old, 'version'), 'utf8')).toBe('1.1.0')
  }
)
it.skipIf(process.platform === 'win32')('重启失败恢复旧应用并留下日志', async () => {
  const fixture = await installFixture(1)
  const result = await runProcess({
    program: '/bin/sh',
    args: [fixture.script, '999999999', fixture.fresh, fixture.old, fixture.root]
  })
  expect(result.code).not.toBe(0)
  expect(await readFile(join(fixture.old, 'version'), 'utf8')).toBe('1.0.0')
  await expect(access(join(fixture.root, 'install.log'))).resolves.toBeUndefined()
})
it('开发或任意安装路径不启动真实替换', async () => {
  await expect(
    launchMacInstaller('/tmp/fake.app', '/tmp/fake', '/tmp/fake.app/Contents/MacOS/HiveWard')
  ).rejects.toThrow('/Applications')
})

it.skipIf(process.platform === 'win32')('旧进程仍在运行时不替换应用', async () => {
  const fixture = await installFixture()
  const script = (await readFile(fixture.script, 'utf8'))
    .replace('"$count" -lt 120', '"$count" -lt 2')
    .replace('sleep 1', 'sleep 0')
  await writeFile(fixture.script, script)
  const result = await runProcess({
    program: '/bin/sh',
    args: [fixture.script, String(process.pid), fixture.fresh, fixture.old, fixture.root]
  })
  expect(result.code).not.toBe(0)
  expect(await readFile(join(fixture.old, 'version'), 'utf8')).toBe('1.0.0')
})
it.skipIf(process.platform === 'win32')('准备新包失败时保持旧应用', async () => {
  const fixture = await installFixture()
  const result = await runProcess({
    program: '/bin/sh',
    args: [
      fixture.script,
      '999999999',
      join(fixture.root, 'missing.app'),
      fixture.old,
      fixture.root
    ]
  })
  expect(result.code).not.toBe(0)
  expect(await readFile(join(fixture.old, 'version'), 'utf8')).toBe('1.0.0')
})
