import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  downloadVerifiedArchive,
  findHiveWardRelease,
  isNewHiveWardVersion,
  readMacReleaseArchive,
  HIVEWARD_RELEASE_API
} from './hiveward-release'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
const payload = {
  tag_name: 'v1.1.0',
  prerelease: false,
  draft: false,
  body: '更新说明',
  assets: []
}
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })

describe('HiveWard 正式版更新', () => {
  it.each(['1.0.0', '0.9.0', '1.1.0-rc.1', 'invalid', '01.1.0', '1.1.0+.', '9007199254740992.0.0'])(
    '不把 %s 当作新正式版',
    (version) => {
      expect(isNewHiveWardVersion('1.0.0', version)).toBe(false)
    }
  )
  it('按语义化版本比较', () => {
    expect(isNewHiveWardVersion('1.9.0', '1.10.0')).toBe(true)
  })
  it('只访问自己的仓库，更新说明来自正式 Release', async () => {
    const fetch = vi.fn().mockResolvedValue(response(payload))
    expect(await findHiveWardRelease('1.0.0', fetch)).toMatchObject({
      version: '1.1.0',
      notes: '更新说明'
    })
    expect(fetch.mock.calls[0][0]).toBe(HIVEWARD_RELEASE_API)
    expect(HIVEWARD_RELEASE_API).toContain('Chaunyzhang/HiveWard')
  })
  it.each([
    { prerelease: true },
    { draft: true },
    { tag_name: 'v1.1.0-rc.1' },
    { tag_name: 'v0.9.0' }
  ])('忽略不适用的发布 %j', async (fields) => {
    expect(
      await findHiveWardRelease(
        '1.0.0',
        vi.fn().mockResolvedValue(response({ ...payload, ...fields }))
      )
    ).toBeNull()
  })
  it('没有首次发布时显示最新，不虚构新版', async () => {
    expect(
      await findHiveWardRelease(
        '1.0.0',
        vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
      )
    ).toBeNull()
  })
  it('网络失败向调用方报告', async () => {
    await expect(
      findHiveWardRelease('1.0.0', vi.fn().mockRejectedValue(new Error('offline')))
    ).rejects.toThrow('offline')
  })
  it('拒绝清单版本不符及错误架构，不接受清单里的任意网址', async () => {
    const release = (await findHiveWardRelease(
      '1.0.0',
      vi.fn().mockResolvedValue(response(payload))
    ))!
    for (const yaml of [
      'version: 1.2.0\nfiles: []',
      'version: 1.1.0\nfiles:\n - url: https://example.invalid/evil.zip'
    ]) {
      await expect(
        readMacReleaseArchive(release, 'arm64', vi.fn().mockResolvedValue(new Response(yaml)))
      ).rejects.toThrow()
    }
  })
})

describe('下载与完整性校验', () => {
  const bytes = Buffer.from('signed HiveWard fixture')
  const archive = {
    url: 'https://github.com/Chaunyzhang/HiveWard/releases/download/v1.1.0/HiveWard-1.1.0-mac-arm64.zip',
    sha512: createHash('sha512').update(bytes).digest('base64'),
    size: bytes.length
  }
  async function destination() {
    const directory = await mkdtemp(join(tmpdir(), 'hiveward-download-test-'))
    directories.push(directory)
    return join(directory, 'update.zip')
  }
  it('下载成功后才将临时文件作为可安装归档', async () => {
    const target = await destination()
    await downloadVerifiedArchive(archive, target, vi.fn().mockResolvedValue(new Response(bytes)))
    expect(await readFile(target)).toEqual(bytes)
  })
  it.each([
    { size: bytes.length - 1 },
    { sha512: createHash('sha512').update('wrong').digest('base64') }
  ])('拒绝不匹配并清理半成品 %j', async (fields) => {
    const target = await destination()
    await expect(
      downloadVerifiedArchive(
        { ...archive, ...fields },
        target,
        vi.fn().mockResolvedValue(new Response(bytes))
      )
    ).rejects.toThrow()
    expect(await readdir(join(target, '..'))).toEqual([])
  })
})

it('拒绝供应商或任意第三方跳转，测试不会访问目标地址', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: 'https://app.hiveward.dev/update' }
    })
  )
  await expect(findHiveWardRelease('1.0.0', fetch)).rejects.toThrow('未授权地址')
  expect(fetch).toHaveBeenCalledOnce()
})
it('跟随 GitHub 发布资源跳转，仍显式禁止自动跳转', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: 'https://release-assets.githubusercontent.com/fixture'
        }
      })
    )
    .mockResolvedValueOnce(response(payload))
  expect(await findHiveWardRelease('1.0.0', fetch)).toMatchObject({ version: '1.1.0' })
  expect(fetch.mock.calls.every((call) => call[1].redirect === 'manual')).toBe(true)
})

it.each([
  'https://api.github.com/repos/other/project/releases/latest',
  'https://github.com/other/project/releases/download/v2.0.0/file.zip'
])('GitHub 跳转也不能换成别人的仓库：%s', async (location) => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 302, headers: { location } }))
  await expect(findHiveWardRelease('1.0.0', fetch)).rejects.toThrow('未授权地址')
  expect(fetch).toHaveBeenCalledOnce()
})

it('构建元数据不参与新旧比较，也不会被连字符误判成预发布', () => {
  expect(isNewHiveWardVersion('1.0.0', '1.1.0+build-with-hyphen')).toBe(true)
  expect(isNewHiveWardVersion('1.0.0', '1.0.0+build-new')).toBe(false)
})
