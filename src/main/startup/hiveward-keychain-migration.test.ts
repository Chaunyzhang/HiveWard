import { describe, expect, it, vi } from 'vitest'

vi.mock('../macos-keychain/generic-password', () => ({
  execSecurityCommand: vi.fn(async () => {
    throw new Error('real security command must not run')
  }),
  isKeychainNotFoundError: (error: unknown) =>
    Boolean(error && typeof error === 'object' && 'code' in error && error.code === 44)
}))

import { adoptHiveWardKeychainIdentity } from './hiveward-keychain-migration'

type Result = { stdout: string; stderr: string }
const notFound = () => Object.assign(new Error('not found'), { code: 44 })

function runner(responses: Record<string, () => Result>) {
  return vi.fn(async (args: string[]): Promise<Result> => {
    const key = args.join(' ')
    const response = responses[key]
    if (!response) {
      throw notFound()
    }
    return response()
  })
}

describe('adoptHiveWardKeychainIdentity', () => {
  it('新条目已存在时直接用新名，不读取旧密钥', async () => {
    const run = runner({
      'find-generic-password -s HiveWard Safe Storage -a HiveWard Key': () => ({
        stdout: '',
        stderr: ''
      })
    })
    await expect(
      adoptHiveWardKeychainIdentity({ platform: 'darwin', dev: false, run })
    ).resolves.toEqual({ use: 'new', appName: 'HiveWard' })
    expect(run).toHaveBeenCalledOnce()
  })

  it('旧条目存在时用 60 秒超时读取，只去掉一个结尾换行后写入新条目', async () => {
    const written: string[] = []
    let readTimeout: number | undefined
    const run = vi.fn(async (args: string[], timeoutMs?: number): Promise<Result> => {
      const key = args.join(' ')
      if (key === 'find-generic-password -s OPC Engine Safe Storage -a OPC Engine Key') {
        return { stdout: 'metadata', stderr: '' }
      }
      if (key === 'find-generic-password -s OPC Engine Safe Storage -a OPC Engine Key -w') {
        readTimeout = timeoutMs
        return { stdout: 'secret-value\n', stderr: '' }
      }
      if (key.startsWith('add-generic-password -s HiveWard Safe Storage -a HiveWard Key -w ')) {
        written.push(args.at(-1) ?? '')
        return { stdout: '', stderr: '' }
      }
      throw notFound()
    })
    await expect(
      adoptHiveWardKeychainIdentity({ platform: 'darwin', dev: false, run })
    ).resolves.toEqual({ use: 'new', appName: 'HiveWard' })
    expect(written).toEqual(['secret-value'])
    expect(readTimeout).toBe(60_000)
    expect(run.mock.calls.some(([args]) => args.includes('delete-generic-password'))).toBe(false)
  })

  it('打包版写入新条目时用 -T 信任当前 App', async () => {
    let added: string[] = []
    const run = vi.fn(async (args: string[]): Promise<Result> => {
      const key = args.join(' ')
      if (key === 'find-generic-password -s OPC Engine Safe Storage -a OPC Engine Key') {
        return { stdout: 'metadata', stderr: '' }
      }
      if (key === 'find-generic-password -s OPC Engine Safe Storage -a OPC Engine Key -w') {
        return { stdout: 'secret-value\n', stderr: '' }
      }
      if (args[0] === 'add-generic-password') {
        added = args
        return { stdout: '', stderr: '' }
      }
      throw notFound()
    })
    await expect(
      adoptHiveWardKeychainIdentity({
        platform: 'darwin',
        dev: false,
        execPath: '/Applications/HiveWard.app/Contents/MacOS/HiveWard',
        run
      })
    ).resolves.toEqual({ use: 'new', appName: 'HiveWard' })
    expect(added).toContain('-T')
    expect(added[added.indexOf('-T') + 1]).toBe('/Applications/HiveWard.app')
  })

  it('dev 写入新条目时不加 -T', async () => {
    let added: string[] = []
    const run = vi.fn(async (args: string[]): Promise<Result> => {
      if (args[0] === 'add-generic-password') {
        added = args
        return { stdout: '', stderr: '' }
      }
      if (
        args.join(' ') ===
        'find-generic-password -s OPC Engine Dev Safe Storage -a OPC Engine Dev Key'
      ) {
        return { stdout: 'metadata', stderr: '' }
      }
      if (
        args.join(' ') ===
        'find-generic-password -s OPC Engine Dev Safe Storage -a OPC Engine Dev Key -w'
      ) {
        return { stdout: 'secret-value\n', stderr: '' }
      }
      throw notFound()
    })
    await expect(
      adoptHiveWardKeychainIdentity({
        platform: 'darwin',
        dev: true,
        execPath: '/tmp/electron',
        run
      })
    ).resolves.toEqual({ use: 'new', appName: 'HiveWard Dev' })
    expect(added).not.toContain('-T')
  })

  it('新旧条目都不存在时按全新安装使用新名', async () => {
    const run = runner({})
    await expect(
      adoptHiveWardKeychainIdentity({ platform: 'darwin', dev: false, run })
    ).resolves.toEqual({ use: 'new', appName: 'HiveWard' })
  })

  it('读取旧密钥被拒绝时本次回退旧名', async () => {
    const run = vi.fn(async (args: string[]): Promise<Result> => {
      const key = args.join(' ')
      if (key === 'find-generic-password -s OPC Engine Dev Safe Storage -a OPC Engine Dev Key') {
        return { stdout: 'metadata', stderr: '' }
      }
      throw new Error('user denied')
    })
    await expect(
      adoptHiveWardKeychainIdentity({ platform: 'darwin', dev: true, run })
    ).resolves.toEqual({ use: 'legacy', appName: 'OPC Engine Dev' })
  })

  it('非 macOS 不执行 security 命令', async () => {
    const run = runner({})
    await expect(
      adoptHiveWardKeychainIdentity({ platform: 'win32', dev: false, run })
    ).resolves.toEqual({ use: 'new', appName: 'HiveWard' })
    expect(run).not.toHaveBeenCalled()
  })
})
