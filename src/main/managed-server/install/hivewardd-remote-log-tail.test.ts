import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@hiveward/process-host'
import {
  HIVEWARDD_LOG_TAIL_LINES,
  HIVEWARDD_LOG_TAIL_MAX_BYTES,
  hivewarddLogTailCommand,
  parseHivewarddLogTail,
  withHivewarddLogTail
} from './hivewardd-remote-log-tail'
import { HIVEWARDD_WINDOWS_HOST_SCRIPT } from '../host-state/hivewardd-windows-host-script'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { unusedHivewarddHostTransport } from '../../ssh/unused-host-transport.test-fixture'

const execCommand = vi.hoisted(() => vi.fn())
vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand
}))

const linux = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')
const SLOT = '/home/me/.hiveward-remote/hivewardd-1.0.0'
const WINDOWS_SLOT = 'C:\\Users\\me\\.hiveward-remote\\hivewardd-1.0.0'
const conn = unusedHivewarddHostTransport()

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hivewardd-log-tail-'))
  execCommand.mockReset()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')
}

describe('hivewardd.log tail', () => {
  it('keeps only the last lines and bytes, redacting secrets', () => {
    const tail = parseHivewarddLogTail(linux, `${numberedLines(100)}\ntoken=abc123secret\n`)
    const lines = (tail ?? '').split('\n')
    expect(lines).toHaveLength(HIVEWARDD_LOG_TAIL_LINES)
    expect(lines[0]).toBe('line 62')
    expect(tail).not.toContain('abc123secret')
    expect(tail).toContain('[redacted')

    const huge = parseHivewarddLogTail(linux, 'x'.repeat(HIVEWARDD_LOG_TAIL_MAX_BYTES * 4))
    expect(Buffer.byteLength(huge ?? '', 'utf8')).toBeLessThanOrEqual(HIVEWARDD_LOG_TAIL_MAX_BYTES)
    expect(parseHivewarddLogTail(linux, '  \n')).toBeNull()
  })

  it('reads the log on Windows through the node.exe host script, never an encoded command', () => {
    const command = hivewarddLogTailCommand(windows, WINDOWS_SLOT)
    expect(command).toContain('node.exe')
    expect(command).toContain(' log-tail ')
    expect(command).not.toMatch(/EncodedCommand/iu)
  })

  it.skipIf(process.platform === 'win32')(
    'runs the POSIX command against a real file',
    async () => {
      const slot = join(dir, 'slot')
      mkdirSync(slot)
      writeFileSync(join(slot, 'hivewardd.log'), `${numberedLines(60)}\n`)
      const run = await runProcess({
        program: '/bin/sh',
        args: ['-c', hivewarddLogTailCommand(linux, slot)],
        timeoutMs: 5_000
      })
      expect(parseHivewarddLogTail(linux, run.stdout)?.split('\n').at(-1)).toBe('line 60')
      const missing = await runProcess({
        program: '/bin/sh',
        args: ['-c', hivewarddLogTailCommand(linux, join(dir, 'absent'))],
        timeoutMs: 5_000
      })
      expect(parseHivewarddLogTail(linux, missing.stdout)).toBeNull()
    }
  )

  it('reads the end of the log through the real Windows host script op', async () => {
    const script = join(dir, 'host-script.js')
    writeFileSync(script, HIVEWARDD_WINDOWS_HOST_SCRIPT)
    const log = join(dir, 'hivewardd.log')
    writeFileSync(log, `${'y'.repeat(HIVEWARDD_LOG_TAIL_MAX_BYTES * 2)}\nfatal: bind failed\n`)
    const run = await runProcess({
      program: process.execPath,
      args: [script, 'log-tail', log, String(HIVEWARDD_LOG_TAIL_MAX_BYTES)],
      timeoutMs: 15_000
    })
    const tail = parseHivewarddLogTail(windows, run.stdout)
    expect(tail?.endsWith('fatal: bind failed')).toBe(true)
    const absent = await runProcess({
      program: process.execPath,
      args: [script, 'log-tail', join(dir, 'absent.log'), '100'],
      timeoutMs: 15_000
    })
    expect(parseHivewarddLogTail(windows, absent.stdout)).toBeNull()
  })

  it('appends the tail to a failure message, and leaves it alone when the host cannot answer', async () => {
    execCommand.mockResolvedValueOnce('starting\nError: EADDRINUSE\n')
    await expect(withHivewarddLogTail({ conn, host: linux }, SLOT, 'Launch failed.')).resolves.toBe(
      'Launch failed.\nLast lines of hivewardd.log:\nstarting\nError: EADDRINUSE'
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    execCommand.mockRejectedValueOnce(new Error('Connection lost'))
    await expect(withHivewarddLogTail({ conn, host: linux }, SLOT, 'Launch failed.')).resolves.toBe(
      'Launch failed.'
    )
    warn.mockRestore()
  })
})
