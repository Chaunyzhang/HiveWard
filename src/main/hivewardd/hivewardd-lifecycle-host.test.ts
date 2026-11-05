import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./hivewardd-browser-startup', () => ({
  startHivewarddBrowserProvider: () => ({ ready: Promise.resolve(), stop: async () => {} })
}))

import { HIVEWARDD_LOCK_FILE_NAME, readHivewarddInstanceLockRecord } from './hivewardd-instance-lock'
import { startHivewarddWithHost } from './hivewardd-lifecycle'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hivewardd-lifecycle-host-'))
  roots.push(root)
  return root
}

describe('startHivewarddWithHost', () => {
  it('names the instance a managed stop must address, and releases its lock on a clean stop', async () => {
    const root = dataRoot()
    const handle = await startHivewarddWithHost(
      root,
      async () => ({}),
      () => {}
    )
    expect(readHivewarddInstanceLockRecord(handle.instance.lockPath)).toMatchObject({
      pid: handle.instance.pid,
      nonce: handle.instance.nonce
    })
    await handle.stop()
    expect(existsSync(join(root, HIVEWARDD_LOCK_FILE_NAME))).toBe(false)
  })

  it('keeps the instance lock when a runtime writer could not be stopped', async () => {
    const root = dataRoot()
    const failure = new Error('profile writer still running')
    const handle = await startHivewarddWithHost(
      root,
      async (registerCleanup) => {
        registerCleanup(() => {
          throw failure
        })
        return {}
      },
      () => {}
    )
    await expect(handle.stop()).rejects.toBe(failure)
    expect(existsSync(join(root, HIVEWARDD_LOCK_FILE_NAME))).toBe(true)
  })

  it('keeps the instance lock when a quit handler fails', async () => {
    const root = dataRoot()
    const handle = await startHivewarddWithHost(
      root,
      async () => ({}),
      () => {
        throw new AggregateError([new Error('handler')], 'hivewardd_quit_handlers_failed')
      }
    )
    await expect(handle.stop()).rejects.toThrow('hivewardd_quit_handlers_failed')
    expect(existsSync(join(root, HIVEWARDD_LOCK_FILE_NAME))).toBe(true)
  })
})
