import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  HivewarddManagedStopRequestSchema,
  type HivewarddManagedStopRequest
} from '../../shared/hivewardd-stop-request'
import { acquireHivewarddInstanceLock } from './hivewardd-instance-lock'
import { hivewarddManagedStopRequestPath } from './hivewardd-managed-stop-request'
import {
  completeHivewarddManagedStop,
  type HivewarddManagedStopCompletionOptions
} from './hivewardd-managed-stop-completion'
import { hivewarddStopReceiptPath } from './hivewardd-completed-stop-receipt'
import type { HivewarddProcessIncarnation } from './hivewardd-process-start-time'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const RECORDED: HivewarddProcessIncarnation = {
  linuxStartTicks: '4242',
  bootId: 'boot-a'
}
// WSL2 btime drift exceeded the 1.5-second wall-clock tolerance.
const DRIFTED_STARTED_AT_MS = 5_000 + 157_000

function running(
  recorded: HivewarddProcessIncarnation | null,
  { requestCarriesIncarnation = false, identity = 'uid-1000' } = {}
): HivewarddManagedStopRequest {
  const root = mkdtempSync(join(tmpdir(), 'hivewardd-stop-identity-'))
  roots.push(root)
  const lock = acquireHivewarddInstanceLock(root, {
    identity: () => identity,
    startedAtMs: () => 5_000,
    incarnation: () => recorded
  })
  const { pid, startedAtMs, nonce } = lock.record
  return {
    schemaVersion: 1,
    transactionId: '0b9f6a3e-9e2c-4c8e-8f58-4c0f6b1d2e3a',
    version: '1.0.0',
    runtimeId: 'runtime-1',
    instance: {
      pid,
      startedAtMs,
      ...(requestCarriesIncarnation && recorded ? recorded : {}),
      nonce,
      lockPath: lock.path
    }
  }
}

function linuxHost(
  actual: HivewarddProcessIncarnation | null,
  aliveFor = Number.POSITIVE_INFINITY
): HivewarddManagedStopCompletionOptions {
  let observations = 0
  return {
    platform: 'linux',
    probeProcess: () => (observations++ < aliveFor ? 'alive' : 'missing'),
    startedAtMs: () => DRIFTED_STARTED_AT_MS,
    incarnation: () => actual,
    sleep: async () => {},
    attempts: 3,
    now: () => new Date('2026-10-01T00:00:00.000Z')
  }
}

const requestWritten = (request: HivewarddManagedStopRequest): boolean =>
  existsSync(hivewarddManagedStopRequestPath(request.instance))

describe('managed stop instance identity', () => {
  it.each([
    ['the lock', false],
    ['the request', true]
  ])(
    'keeps a drifted-btime instance live by its ticks from %s, writes the request, then proves exit',
    async (_source, requestCarriesIncarnation) => {
      const request = running(RECORDED, { requestCarriesIncarnation })
      expect(await completeHivewarddManagedStop(request, linuxHost(RECORDED, 2))).toBe('exited')
      expect(requestWritten(request)).toBe(true)
      expect(existsSync(hivewarddStopReceiptPath(request, 'completed'))).toBe(true)
    }
  )

  it.each([
    ['different start ticks', { ...RECORDED, linuxStartTicks: '9999' }],
    ['a different boot', { ...RECORDED, bootId: 'boot-b' }]
  ])('proves exit for a PID now naming a process with %s', async (_name, actual) => {
    const request = running(RECORDED)
    expect(await completeHivewarddManagedStop(request, linuxHost(actual))).toBe('exited')
    expect(requestWritten(request)).toBe(false)
  })

  it('stays live, never exited, while the incarnation cannot be read', async () => {
    const request = running(RECORDED)
    expect(await completeHivewarddManagedStop(request, linuxHost(null))).toBe('live')
    expect(requestWritten(request)).toBe(true)
  })

  it('answers unverifiable, not exited, for an older lock whose wall-clock time drifted', async () => {
    const request = running(null)
    expect(await completeHivewarddManagedStop(request, linuxHost(RECORDED))).toBe('unverifiable')
    expect(existsSync(hivewarddStopReceiptPath(request, 'completed'))).toBe(false)
  })

  it.each([
    ['another non-root uid', 1001, 'exited'],
    ['root', 0, 'unverifiable'],
    ['the same uid', 1000, 'unverifiable']
  ] as const)(
    'for an older lock whose wall-clock time disagrees, a PID owned by %s is %s',
    async (_owner, ownerUid, verdict) => {
      const request = running(null, { identity: '1000' })
      const host = { ...linuxHost(RECORDED), ownerUid: () => ownerUid }
      expect(await completeHivewarddManagedStop(request, host)).toBe(verdict)
      expect(existsSync(hivewarddStopReceiptPath(request, 'completed'))).toBe(verdict === 'exited')
      expect(requestWritten(request)).toBe(false)
    }
  )

  it('takes no owner proof from a lock that no longer names the instance', async () => {
    const request = running(null, { identity: '1000' })
    const lock = JSON.parse(readFileSync(request.instance.lockPath, 'utf8'))
    writeFileSync(request.instance.lockPath, JSON.stringify({ ...lock, nonce: 'successor' }))
    const host = { ...linuxHost(RECORDED), ownerUid: () => 1001 }
    expect(await completeHivewarddManagedStop(request, host)).toBe('unverifiable')
  })

  it('stays readable by peers on either side of the change', async () => {
    const request = running(RECORDED, { requestCarriesIncarnation: true })
    // Older readers strip the added incarnation fields.
    const olderInstance = z.object({
      pid: z.number().int().positive(),
      startedAtMs: z.number().finite().nonnegative().nullable(),
      nonce: z.string().min(1),
      lockPath: z.string().min(1)
    })
    const { linuxStartTicks: _ticks, bootId: _boot, ...withoutIncarnation } = request.instance
    expect(olderInstance.parse(request.instance)).toEqual(withoutIncarnation)
    // New readers recover the missing incarnation from the lock.
    const fromOlderClient = HivewarddManagedStopRequestSchema.parse({
      ...request,
      instance: withoutIncarnation
    })
    expect(fromOlderClient.instance).not.toHaveProperty('linuxStartTicks')
    expect(await completeHivewarddManagedStop(fromOlderClient, linuxHost(RECORDED, 2))).toBe('exited')
    expect(JSON.parse(readFileSync(hivewarddManagedStopRequestPath(request.instance), 'utf8'))).toEqual(
      fromOlderClient
    )
  })

  it('matches its own receipt when an older client retries without the incarnation', async () => {
    const request = running(RECORDED, { requestCarriesIncarnation: true })
    expect(await completeHivewarddManagedStop(request, linuxHost(RECORDED, 2))).toBe('exited')
    const { linuxStartTicks: _ticks, bootId: _boot, ...withoutIncarnation } = request.instance
    const retried = { ...request, instance: withoutIncarnation }
    expect(await completeHivewarddManagedStop(retried, linuxHost(RECORDED, 0))).toBe('exited')
  })
})
