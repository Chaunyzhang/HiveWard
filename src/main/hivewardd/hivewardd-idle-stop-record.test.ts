import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeHivewarddIdleStopRecord,
  hivewarddIdleStopRecordPath,
  writeHivewarddIdleStopRecord
} from './hivewardd-idle-stop-record'
import { createIdleStopRecordOwnership } from './hivewardd-managed-idle-exit-host'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hivewardd-idle-stop-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('hivewardd idle-stop record', () => {
  it('lets the next start tell an idle stop apart from a crash, exactly once', () => {
    writeHivewarddIdleStopRecord(
      root,
      {
        quietSince: Date.parse('2026-10-03T10:00:00Z'),
        stoppedAt: Date.parse('2026-10-03T10:15:00Z'),
        timeoutMs: 900_000
      },
      '1.2.3'
    )

    expect(consumeHivewarddIdleStopRecord(root)).toMatchObject({
      kind: 'hivewardd_idle_stop',
      pid: process.pid,
      version: '1.2.3',
      quietSince: '2026-10-03T10:00:00.000Z',
      stoppedAt: '2026-10-03T10:15:00.000Z',
      idleTimeoutMs: 900_000
    })
    expect(consumeHivewarddIdleStopRecord(root)).toBeNull()
  })

  it('drops a corrupt record instead of trusting it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(hivewarddIdleStopRecordPath(root), '{"kind":"hivewardd_idle_stop"')

    expect(consumeHivewarddIdleStopRecord(root)).toBeNull()
    expect(existsSync(hivewarddIdleStopRecordPath(root))).toBe(false)
  })

  it('drops the record when a signal stop already owned the shutdown', () => {
    const evidence = { quietSince: 1, stoppedAt: 2, timeoutMs: 3 }
    writeHivewarddIdleStopRecord(root, evidence, '1.0.0')
    createIdleStopRecordOwnership(root).requestShutdown(() => false)
    expect(existsSync(hivewarddIdleStopRecordPath(root))).toBe(false)

    writeHivewarddIdleStopRecord(root, evidence, '1.0.0')
    const owned = createIdleStopRecordOwnership(root)
    let onFailed: (() => void) | undefined
    owned.requestShutdown((_reason, failed) => {
      onFailed = failed
      return true
    })
    owned.onShutdown()
    expect(existsSync(hivewarddIdleStopRecordPath(root))).toBe(true)
    onFailed?.()
    expect(existsSync(hivewarddIdleStopRecordPath(root))).toBe(false)
  })

  it('drops the record when a signal stop finishes before the idle stop asks to shut down', () => {
    writeHivewarddIdleStopRecord(root, { quietSince: 1, stoppedAt: 2, timeoutMs: 3 }, '1.0.0')
    createIdleStopRecordOwnership(root).onShutdown()
    expect(existsSync(hivewarddIdleStopRecordPath(root))).toBe(false)
  })
})
