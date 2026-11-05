import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import type * as FileSystem from 'node:fs/promises'
import { join } from 'node:path'
const fixture = vi.hoisted(() => {
  const directories: string[] = []
  return {
    run: vi.fn(),
    directories,
    entries: 'HiveWard.app/\nHiveWard.app/Contents/Info.plist\n',
    attributes: '',
    link: '',
    version: '1.1.0',
    code: 0
  }
})
vi.mock('@hiveward/process-host', () => ({ runProcess: fixture.run, spawnProcess: vi.fn() }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FileSystem>()
  return {
    ...fs,
    mkdtemp: async (prefix: string) => {
      const directory = await fs.mkdtemp(prefix)
      fixture.directories.push(directory)
      return directory
    }
  }
})
import { prepareMacUpdate } from './hiveward-mac-installer'
beforeEach(() => {
  fixture.run.mockClear()
  fixture.entries = 'HiveWard.app/\nHiveWard.app/Contents/Info.plist\n'
  fixture.attributes = ''
  fixture.link = ''
  fixture.version = '1.1.0'
  fixture.code = 0
  fixture.run.mockImplementation(async ({ program, args }) => {
    let stdout = ''
    if (program === '/usr/bin/unzip') {
      stdout =
        args[0] === '-Z1' ? fixture.entries : args[0] === '-p' ? fixture.link : fixture.attributes
    } else if (program === '/usr/bin/ditto') {
      await mkdir(join(args.at(-1), 'HiveWard.app/Contents'), { recursive: true })
    } else if (program === '/usr/libexec/PlistBuddy') {
      stdout = args[1].includes('Identifier') ? 'app.hiveward' : fixture.version
    }
    return { stdout, stderr: '', code: fixture.code, timedOut: false }
  })
})
afterEach(async () => {
  await Promise.all(
    fixture.directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})
it('解压后验证 HiveWard 身份、版本和最终签名', async () => {
  const result = await prepareMacUpdate('/tmp/mock.zip', '1.1.0', 'app.hiveward')
  expect(result.app).toBe(join(result.directory, 'HiveWard.app'))
  expect(fixture.run).toHaveBeenCalledWith(
    expect.objectContaining({
      program: '/usr/bin/codesign',
      args: ['--verify', '--deep', '--strict', result.app]
    })
  )
})
it('工具失败或版本不符时不提供可安装 App', async () => {
  fixture.code = 1
  await expect(prepareMacUpdate('/tmp/mock.zip', '1.1.0', 'app.hiveward')).rejects.toThrow(
    '更新准备失败'
  )
  fixture.code = 0
  fixture.version = '1.4.214'
  await expect(prepareMacUpdate('/tmp/mock.zip', '1.1.0', 'app.hiveward')).rejects.toThrow(
    '版本不一致'
  )
})
it.each([
  '/tmp/escape',
  '../escape',
  'HiveWard.app/../../escape',
  'HiveWard.app\\escape',
  'install.sh',
  'install.log',
  'Other.app/Contents/file'
])('解压前拒绝路径穿越 %s', async (entry) => {
  fixture.entries = entry
  await expect(prepareMacUpdate('/tmp/mock.zip', '1.1.0', 'app.hiveward')).rejects.toThrow(
    '不安全路径'
  )
  expect(fixture.run.mock.calls.some(([call]) => call.program === '/usr/bin/ditto')).toBe(false)
})
it('保留 App 内 Framework 链接，但解压前拒绝越界链接', async () => {
  fixture.entries += 'HiveWard.app/Contents/Frameworks/F.framework/Current\n'
  fixture.attributes = 'lrwxr-xr-x fixture HiveWard.app/Contents/Frameworks/F.framework/Current'
  fixture.link = 'Versions/A'
  await expect(prepareMacUpdate('/tmp/mock.zip', '1.1.0', 'app.hiveward')).resolves.toHaveProperty(
    'app'
  )
  fixture.link = '../../../../../outside'
  await expect(prepareMacUpdate('/tmp/mock.zip', '1.1.0', 'app.hiveward')).rejects.toThrow(
    '越界链接'
  )
})

it('允许系统 ZIP 的资源元数据，安装脚本目录仍保持独立', async () => {
  fixture.entries += '__MACOSX/._HiveWard.app\n'
  await expect(prepareMacUpdate('/tmp/mock.zip', '1.1.0', 'app.hiveward')).resolves.toHaveProperty(
    'app'
  )
})
