import { describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { execSecurityCommand } from './generic-password'

function respond() {
  execFileMock.mockImplementation(
    (
      _command: string,
      _args: string[],
      options: { timeout: number },
      callback: (error: null, stdout: string, stderr: string) => void
    ) => {
      callback(null, '', '')
      return { timeout: options.timeout, kill() {} }
    }
  )
}

describe('execSecurityCommand', () => {
  it('默认 3 秒超时', async () => {
    respond()
    await execSecurityCommand(['find-generic-password', '-s', 'service'])
    expect(execFileMock.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 3_000 })
  })

  it('可传更长的超时等待用户授权', async () => {
    respond()
    await execSecurityCommand(['find-generic-password', '-s', 'service', '-w'], 60_000)
    expect(execFileMock.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 60_000 })
  })
})
