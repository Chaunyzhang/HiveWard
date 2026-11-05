import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error && error.message === 'channel lost'
}))

vi.mock('../../ssh/ssh-remote-platform-detection', () => ({ detectRemoteHostPlatform: vi.fn() }))
vi.mock('../host-state/hivewardd-windows-host-preparation', () => ({
  prepareWindowsHivewarddHost: vi.fn()
}))

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { detectRemoteHostPlatform } from '../../ssh/ssh-remote-platform-detection'
import { prepareWindowsHivewarddHost } from '../host-state/hivewardd-windows-host-preparation'
import { resolveHivewarddRemoteContext } from './hivewardd-remote-context'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'
import {
  readBoundedHivewarddRemoteRecord,
  writeAtomicHivewarddRemoteRecord
} from './hivewardd-remote-record-file'
import {
  readHivewarddActivationRecord,
  writeHivewarddActivationRecord
} from '../activation/hivewardd-activation-record-store'
import { emptyHivewarddActivationRecord } from '../activation/hivewardd-activation-record'
import { readRemoteHivewarddBuildHash } from './hivewardd-remote-build-hash'
import {
  launchHivewarddSlotAndAwaitReadiness,
  HivewarddActiveReadinessError,
  probeActiveHivewarddReadiness
} from '../../ssh/hivewardd-active-readiness'
import { parseHivewarddReadinessOutput } from './hivewardd-remote-launch'

const mockExec = vi.mocked(execCommand)
const linux = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')
const conn: HivewarddHostTransport = Object.create(null)
const target = { conn, host: linux }
const BUILD_HASH = 'abc123def4567890'

function readyLine(
  buildHash = BUILD_HASH,
  daemon: { coverage?: 'pty-spawn' | 'handshake'; platform?: string } = {}
): string {
  const selfTest = { ok: true, verdict: 'healthy', durationMs: 5 }
  return JSON.stringify({
    type: 'hiveward_server_ready',
    runtimeId: 'r1',
    boundEndpoint: 'ws://127.0.0.1:7777',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
    health: {
      buildHash,
      buildVersion: '0.2.0+bb01',
      nodeVersion: '24.21.0',
      nodeAbi: '137',
      platform: daemon.platform ?? 'linux',
      arch: 'x64',
      pid: 1,
      terminalDaemon: {
        state: 'live',
        ownsFreshSessions: true,
        pid: 2,
        buildVersion: '0.2.0+bb01',
        entryPath: '/x/daemon-entry.js',
        protocolVersion: 38,
        selfTest:
          'coverage' in daemon
            ? { ...selfTest, ...(daemon.coverage ? { coverage: daemon.coverage } : {}) }
            : { ...selfTest, coverage: 'pty-spawn' }
      }
    }
  })
}

beforeEach(() => {
  mockExec.mockReset()
})

describe('hivewardd host record files', () => {
  it('tells an absent record from one whose read gave no answer', async () => {
    mockExec.mockResolvedValueOnce('__HIVEWARDD_RECORD_ABSENT__\n')
    await expect(readBoundedHivewarddRemoteRecord(target, '/r.json', 64)).resolves.toEqual({
      state: 'absent'
    })
    mockExec.mockResolvedValueOnce('__HIVEWARDD_RECORD_PRESENT__\n{"a":1}')
    await expect(readBoundedHivewarddRemoteRecord(target, '/r.json', 64)).resolves.toEqual({
      state: 'present',
      raw: '{"a":1}'
    })
    mockExec.mockResolvedValueOnce('')
    await expect(readBoundedHivewarddRemoteRecord(target, '/r.json', 64)).rejects.toThrow(
      'no verifiable answer'
    )
  })

  it('keeps the partial file when the write may still be running on the host', async () => {
    mockExec.mockRejectedValueOnce(new Error('channel lost'))
    await expect(writeAtomicHivewarddRemoteRecord(target, '/r.json', '{}')).rejects.toThrow()
    expect(mockExec).toHaveBeenCalledOnce()
    mockExec.mockRejectedValueOnce(new Error('exit 1')).mockResolvedValueOnce('')
    await expect(writeAtomicHivewarddRemoteRecord(target, '/r.json', '{}')).rejects.toThrow()
    expect(String(mockExec.mock.calls.at(-1)?.[1])).toContain('rm -f')
  })

  it('refuses a Windows read that names no pinned node.exe to run it', async () => {
    await expect(
      readBoundedHivewarddRemoteRecord({ conn, host: windows }, 'C:/r.json', 64)
    ).rejects.toThrow('pinned node.exe')
    expect(mockExec).not.toHaveBeenCalled()
  })
})

describe('activation record store', () => {
  const options = { conn, host: linux, remoteHome: '/home/u' }
  const newer = JSON.stringify({ ...emptyHivewarddActivationRecord(), schemaVersion: 2 })

  it('reads a lost read as an error, never as an empty record', async () => {
    mockExec.mockRejectedValueOnce(new Error('channel lost'))
    await expect(readHivewarddActivationRecord(options)).rejects.toThrow('channel lost')
  })

  it('reads a newer schema as unreadable and never overwrites it', async () => {
    mockExec.mockResolvedValue(`__HIVEWARDD_RECORD_PRESENT__\n${newer}`)
    await expect(readHivewarddActivationRecord(options)).rejects.toThrow('schemaVersion 2')
    await expect(writeHivewarddActivationRecord(options, emptyHivewarddActivationRecord())).rejects.toThrow(
      'Refusing to overwrite'
    )
    expect(mockExec.mock.calls.some(([, command]) => String(command).includes('mv -f'))).toBe(false)
  })

  it('writes atomically when the host has no record yet', async () => {
    mockExec.mockResolvedValueOnce('__HIVEWARDD_RECORD_ABSENT__\n').mockResolvedValueOnce('')
    await writeHivewarddActivationRecord(options, emptyHivewarddActivationRecord())
    expect(String(mockExec.mock.calls[1]?.[1])).toMatch(/printf %s .* && mv -f /s)
  })
})

describe('installed build identity and readiness', () => {
  const slot = { ...target, remoteInstallDir: '/home/u/.hiveward-remote/hivewardd-0.2.0+bb01' }
  const expectation = { buildHash: BUILD_HASH, fullVersion: '0.2.0+bb01' }

  it('reads the 16-hex build hash the slot reports', async () => {
    mockExec.mockResolvedValueOnce(`noise\n__HIVEWARDD_BUILD_HASH__ ${BUILD_HASH.toUpperCase()}\n`)
    await expect(readRemoteHivewarddBuildHash(target, '/slot')).resolves.toBe(BUILD_HASH)
    mockExec.mockResolvedValueOnce('')
    await expect(readRemoteHivewarddBuildHash(target, '/slot')).rejects.toThrow()
  })

  it.each([
    ['DEAD', 'exited'],
    ['UNKNOWN', 'unverifiable'],
    ['', 'unverifiable']
  ])('reports a %j liveness probe as %s', async (liveness, verdict) => {
    mockExec.mockResolvedValueOnce(liveness)
    await expect(probeActiveHivewarddReadiness(slot, expectation)).rejects.toMatchObject({
      verdict
    })
  })

  it('accepts only the expected build once the process is live', async () => {
    mockExec.mockResolvedValueOnce('LIVE').mockResolvedValueOnce(`${readyLine()}\n`)
    await expect(probeActiveHivewarddReadiness(slot, expectation)).resolves.toMatchObject({
      runtimeId: 'r1'
    })
    mockExec
      .mockResolvedValueOnce('LIVE')
      .mockResolvedValueOnce(`${readyLine('ffffffffffffffff')}\n`)
    const rejected = probeActiveHivewarddReadiness(slot, expectation)
    await expect(rejected).rejects.toBeInstanceOf(HivewarddActiveReadinessError)
    await expect(rejected).rejects.toMatchObject({ verdict: 'rejected' })
  })

  it.each([
    ['a spawn-probed PTY', { coverage: 'pty-spawn' as const }],
    [
      'a handshake on a host whose daemon never spawn-probes',
      { coverage: 'handshake' as const, platform: 'win32' }
    ],
    ['an older build that does not report coverage', { coverage: undefined }]
  ])('accepts %s', async (_name, daemon) => {
    mockExec
      .mockResolvedValueOnce('LIVE')
      .mockResolvedValueOnce(`${readyLine(BUILD_HASH, daemon)}\n`)
    await expect(probeActiveHivewarddReadiness(slot, expectation)).resolves.toMatchObject({
      runtimeId: 'r1'
    })
  })

  it('rejects handshake-only coverage on a host whose daemon should spawn a PTY', async () => {
    mockExec
      .mockResolvedValueOnce('LIVE')
      .mockResolvedValueOnce(`${readyLine(BUILD_HASH, { coverage: 'handshake' })}\n`)
    await expect(probeActiveHivewarddReadiness(slot, expectation)).rejects.toMatchObject({
      verdict: 'rejected',
      message: expect.stringContaining("coverage 'handshake'")
    })
  })

  it('applies the same coverage rule to a slot it launches', async () => {
    mockExec
      .mockResolvedValueOnce('4242')
      .mockResolvedValueOnce(`${readyLine(BUILD_HASH, { coverage: 'handshake' })}\n`)
    await expect(
      launchHivewarddSlotAndAwaitReadiness(
        { ...target, readinessTimeoutMs: 1_000, sleep: async () => {} },
        {
          remoteInstallDir: slot.remoteInstallDir,
          nodePath: '/usr/bin/node',
          fullVersion: '0.2.0+bb01',
          userDataDir: '/home/u/.hiveward',
          bindHost: '127.0.0.1',
          port: 7777,
          activationRoot: '/home/u/.hiveward-remote/.hivewardd-activation-transaction'
        },
        expectation
      )
    ).rejects.toMatchObject({ verdict: 'rejected' })
  })

  it('reads readiness once even when the client was descheduled past its deadline', async () => {
    mockExec.mockResolvedValueOnce('4242').mockResolvedValueOnce(`${readyLine(BUILD_HASH)}\n`)
    await expect(
      launchHivewarddSlotAndAwaitReadiness(
        { ...target, readinessTimeoutMs: 0, sleep: async () => {} },
        {
          remoteInstallDir: slot.remoteInstallDir,
          nodePath: '/usr/bin/node',
          fullVersion: '0.2.0+bb01',
          userDataDir: '/home/u/.hiveward',
          bindHost: '127.0.0.1',
          port: 7777,
          activationRoot: '/home/u/.hiveward-remote/.hivewardd-activation-transaction'
        },
        expectation
      )
    ).resolves.toMatchObject({ runtimeId: 'r1' })
  })
})

describe('readiness parsing bounds', () => {
  it('waits on a half-written last line but rejects a finished invalid one', () => {
    expect(parseHivewarddReadinessOutput('{"type":"hiveward_ser')).toEqual({ state: 'pending' })
    expect(parseHivewarddReadinessOutput('{"type":"hiveward_ser\n')).toMatchObject({
      state: 'malformed'
    })
  })

  it('rejects a payload over the size cap', () => {
    expect(parseHivewarddReadinessOutput('x'.repeat(256 * 1024 + 1))).toMatchObject({
      state: 'malformed'
    })
  })
})

describe('hivewardd remote context', () => {
  it('prepares a Windows host (runtime, host script) before reading the activation record', async () => {
    vi.mocked(detectRemoteHostPlatform).mockResolvedValueOnce(windows)
    const order: string[] = []
    vi.mocked(prepareWindowsHivewarddHost).mockImplementationOnce(async () => {
      order.push('prepare')
    })
    mockExec.mockImplementation(async (_conn, command: string) => {
      if (command.includes('record-read')) {
        order.push('record')
        return '__HIVEWARDD_RECORD_ABSENT__\r\n'
      }
      return 'C:\\Users\\u\r\n'
    })
    const sshTarget = { id: 't', label: 't', host: 'h', port: 22, username: 'u' }
    const context = await resolveHivewarddRemoteContext(sshTarget, conn)
    expect(context).toMatchObject({ serverTarget: 'win32-x64', remoteHome: 'C:/Users/u' })
    expect(vi.mocked(prepareWindowsHivewarddHost).mock.calls[0]?.[0]).toMatchObject({
      remoteHome: 'C:/Users/u',
      serverTarget: 'win32-x64'
    })
    expect(order).toEqual(['prepare', 'record'])
  })

  it('uses a WSL caller-known platform and login home instead of probing them', async () => {
    vi.mocked(detectRemoteHostPlatform).mockClear()
    const commands: string[] = []
    mockExec.mockImplementation(async (_conn, command: string) => {
      commands.push(command)
      return command.includes('ldd') ? 'ldd (GNU libc) 2.39\n' : '__HIVEWARDD_RECORD_ABSENT__\n'
    })
    const wslTarget = { kind: 'wsl', id: 'wsl:u', distro: 'U', label: 'U' } as const

    const context = await resolveHivewarddRemoteContext(wslTarget, conn, undefined, linux, {
      loginHome: '/home/u\n',
      firstLibcProbeOutput: 'ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39\n'
    })

    expect(context).toMatchObject({
      remoteHome: '/home/u',
      userDataDir: '/home/u/.hiveward',
      serverTarget: 'linux-x64-glibc'
    })
    expect(detectRemoteHostPlatform).not.toHaveBeenCalled()
    expect(commands.some((command) => command.includes('$HOME'))).toBe(false)
    expect(commands.some((command) => command.includes('ldd'))).toBe(false)
  })

  it('runs the libc fallbacks when the folded first probe proves nothing', async () => {
    vi.mocked(detectRemoteHostPlatform).mockClear()
    const commands: string[] = []
    mockExec.mockImplementation(async (_conn, command: string) => {
      commands.push(command)
      return command.includes('getconf') ? 'glibc 2.39\n' : '__HIVEWARDD_RECORD_ABSENT__\n'
    })
    const wslTarget = { kind: 'wsl', id: 'wsl:u', distro: 'U', label: 'U' } as const

    const context = await resolveHivewarddRemoteContext(wslTarget, conn, undefined, linux, {
      loginHome: '/home/u',
      firstLibcProbeOutput: 'sh: ldd: not found\n'
    })

    expect(context.serverTarget).toBe('linux-x64-glibc')
    // The same plain exec the default probe uses, not the fenced hivewardd runner.
    expect(mockExec).toHaveBeenCalledWith(conn, expect.stringContaining('getconf'), {
      signal: undefined
    })
    expect(commands.some((command) => command.includes('ldd --version'))).toBe(false)
  })
})
