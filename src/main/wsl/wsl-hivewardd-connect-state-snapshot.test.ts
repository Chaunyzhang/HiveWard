import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../ssh/remote-exec/remote-exec-command'
import { runProcess } from '@hiveward/process-host'

vi.mock('../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import {
  emptyHivewarddActivationRecord,
  serializeHivewarddActivationRecord,
  withActivatedVersion
} from '../managed-server/activation/hivewardd-activation-record'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { HivewarddHostTransport } from '../ssh/hivewardd-host-transport'
import {
  createWslHivewarddConnectStateReader,
  parseWslHivewarddConnectState,
  wslHivewarddConnectStateHints
} from './wsl-hivewardd-connect-state-snapshot'

const mockExec = vi.mocked(execCommand)
const host = getRemoteHostPlatform('linux-x64')
const ACTIVE = withActivatedVersion(
  emptyHivewarddActivationRecord(),
  '0.1.0+aa01',
  null,
  new Date('2026-02-02T00:00:00.000Z')
)
let home: string

function target() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked, so the transport is never used.
  const conn = Object.create(null) as HivewarddHostTransport
  return { conn, host, remoteHome: home, userDataDir: join(home, '.hiveward') }
}

function write(relative: string, content: string): void {
  const path = join(home, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hiveward-wsl-connect-state-'))
  mockExec.mockReset()
  mockExec.mockImplementation(async (_conn, command) => {
    const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout
  })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('WSL connect state snapshot', () => {
  it('reads the record, a pending journal, the instance lock and a held fence together', async () => {
    write('.hiveward-remote/hivewardd-active.json', serializeHivewarddActivationRecord(ACTIVE))
    write('.hiveward-remote/.hivewardd-activation-transaction/transaction.json', '{"partial"')
    mkdirSync(join(home, '.hiveward-remote/.hivewardd-activation-transaction/.install-lock'))
    write('.hiveward/hivewardd.lock', '{"pid":7}\n')
    const reader = createWslHivewarddConnectStateReader()

    await expect(reader.readActivationRecord(target())).resolves.toEqual(ACTIVE)

    expect(mockExec).toHaveBeenCalledOnce()
    expect(reader.snapshot()).toMatchObject({
      transactionAbsent: false,
      instanceLock: { state: 'present', raw: '{"pid":7}' },
      fenceOpen: false
    })
  })

  it('fails closed on an oversized record, as the plain read does', async () => {
    write('.hiveward-remote/hivewardd-active.json', `"${'x'.repeat(70 * 1024)}"`)
    const reader = createWslHivewarddConnectStateReader()

    // The plain read refuses an oversized file too (exit 65), so the connect still fails closed.
    await expect(reader.readActivationRecord(target())).rejects.toThrow()
    expect(mockExec).toHaveBeenCalledTimes(2)
    expect(reader.snapshot()).toBeNull()
  })

  it('falls back to the plain record read when the answer has another shape', async () => {
    write('.hiveward-remote/hivewardd-active.json', serializeHivewarddActivationRecord(ACTIVE))
    mockExec.mockImplementationOnce(async () => 'startup noise\n')
    const reader = createWslHivewarddConnectStateReader()

    await expect(reader.readActivationRecord(target())).resolves.toEqual(ACTIVE)

    expect(mockExec).toHaveBeenCalledTimes(2)
    expect(reader.snapshot()).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('WSL connect state snapshot fallbacks', () => {
  it('falls back to the plain read when the snapshot command itself fails', async () => {
    write('.hiveward-remote/hivewardd-active.json', serializeHivewarddActivationRecord(ACTIVE))
    mockExec.mockImplementationOnce(async () => {
      throw new Error('transport closed')
    })
    const reader = createWslHivewarddConnectStateReader()

    await expect(reader.readActivationRecord(target())).resolves.toEqual(ACTIVE)
    expect(reader.snapshot()).toBeNull()
  })

  it('gives no hints when only the fallback read could answer the record', async () => {
    write('.hiveward-remote/hivewardd-active.json', serializeHivewarddActivationRecord(ACTIVE))
    mockExec.mockImplementationOnce(
      async () =>
        'UNREADABLE\n__HIVEWARD_WSL_CONNECT_STATE_END__\nABSENT\n__HIVEWARD_WSL_CONNECT_STATE_END__\n' +
        'ABSENT\n__HIVEWARD_WSL_CONNECT_STATE_END__\nNONE\n__HIVEWARD_WSL_CONNECT_STATE_END__\nOPEN\n'
    )
    const reader = createWslHivewarddConnectStateReader()

    await expect(reader.readActivationRecord(target())).resolves.toEqual(ACTIVE)
    expect(reader.snapshot()).toBeNull()
  })
})

describe.runIf(process.platform === 'linux')('WSL connect state snapshot on a Linux guest', () => {
  it("reads the lock holder's identity in the same command", async () => {
    write('.hiveward/hivewardd.lock', `${JSON.stringify({ pid: process.pid, version: '0.1.0' })}\n`)
    const reader = createWslHivewarddConnectStateReader()

    await reader.readActivationRecord(target())

    expect(mockExec).toHaveBeenCalledOnce()
    const lock = reader.snapshot()?.instanceLock
    expect(lock?.state === 'present' && lock.holder?.pid).toBe(process.pid)
    expect(lock?.state === 'present' && lock.holder?.guest.hivewardd).toMatch(`${process.pid}:`)
  })
})

describe('parseWslHivewarddConnectState', () => {
  const end = '\n__HIVEWARD_WSL_CONNECT_STATE_END__\n'
  const stat = (pid: number) =>
    `${pid} (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 77 0`
  const identity = (pid: number) =>
    `PID ${pid}\n0f6e1d2c-3b4a-4958-8776-655443322110\n--hiveward-identity--\n${stat(1)}\n` +
    `--hiveward-identity--\n${stat(pid)}\n--hiveward-identity--\n`
  const answer = (holder: string) =>
    `ABSENT${end}ABSENT${end}PRESENT\n{"pid":9}${end}${holder}${end}OPEN\n`

  it('attaches the holder identity to a present lock, and nothing it cannot parse', () => {
    const lock = parseWslHivewarddConnectState(answer(identity(9)))?.instanceLock
    expect(lock).toMatchObject({ state: 'present', holder: { pid: 9, guest: { hivewardd: '9:77' } } })
    expect(parseWslHivewarddConnectState(answer('NONE'))?.instanceLock).toEqual({
      state: 'present',
      raw: '{"pid":9}'
    })
    expect(parseWslHivewarddConnectState(answer('PID 9\nnoise'))?.instanceLock).not.toHaveProperty(
      'holder'
    )
  })

  it('rejects a truncated answer', () => {
    expect(parseWslHivewarddConnectState('ABSENT\n__HIVEWARD_WSL_CONNECT_STATE_END__\n')).toBeNull()
  })
})

describe('wslHivewarddConnectStateHints', () => {
  const snapshot = {
    activation: { state: 'ok' as const, record: ACTIVE },
    transactionAbsent: true,
    instanceLock: { state: 'absent' as const },
    fenceOpen: true
  }

  it('stops hinting once recovery, adoption or admission replaced the record', () => {
    const hints = wslHivewarddConnectStateHints(snapshot, ACTIVE)
    const replaced = { ...ACTIVE }
    expect(hints.instanceLock(replaced)).toBeUndefined()
    expect(hints.deployPreRead(replaced)).toEqual({})
  })
})
