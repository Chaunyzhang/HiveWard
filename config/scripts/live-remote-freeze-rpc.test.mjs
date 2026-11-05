import { describe, expect, it } from 'vitest'
import {
  appendHiveWardRpcOutput,
  resolveHiveWardCliCommand,
  resolveHiveWardCliInvocation
} from './live-remote-freeze-rpc.mjs'

describe('live remote freeze RPC', () => {
  it('resolves the HiveWard CLI for managed, dev, Linux, and default runtimes', () => {
    expect(resolveHiveWardCliCommand({ env: { HIVEWARD_CLI_COMMAND: 'custom-hiveward' } })).toBe('custom-hiveward')
    expect(resolveHiveWardCliCommand({ env: { HIVEWARD_DEV_REPO_ROOT: '/repo' } })).toBe('hiveward-dev')
    expect(resolveHiveWardCliCommand({ env: {}, platform: 'linux' })).toBe('hiveward-ide')
    expect(resolveHiveWardCliCommand({ env: {}, platform: 'win32' })).toBe('hiveward')
  })

  it('bypasses the Windows dev cmd shim with the built Node CLI', () => {
    const invocation = resolveHiveWardCliInvocation({
      env: {
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        HIVEWARD_CLI_COMMAND: 'C:\\repo\\out\\bin\\hiveward-dev.cmd',
        HIVEWARD_DEV_REPO_ROOT: 'C:\\repo'
      },
      platform: 'win32',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe'
    })

    expect(invocation).toMatchObject({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: ['C:\\repo\\out\\cli\\index.js'],
      env: {
        HIVEWARD_USER_DATA_PATH: 'C:\\Users\\dev\\AppData\\Roaming\\hiveward-dev',
        HIVEWARD_DEV_CLI_INVOCATION: '1',
        HIVEWARD_APP_EXECUTABLE: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
        HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT: '1'
      }
    })
  })

  it('caps combined asynchronous output before retaining the overflow chunk', () => {
    const first = appendHiveWardRpcOutput('', '1234', 0, 5)
    expect(first).toEqual({ output: '1234', bytes: 4, exceeded: false })

    const overflow = appendHiveWardRpcOutput(first.output, '67', first.bytes, 5)
    expect(overflow).toEqual({ output: '1234', bytes: 6, exceeded: true })
  })
})
