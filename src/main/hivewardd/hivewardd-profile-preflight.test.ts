import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProcessResult, ProcessSpec } from '@hiveward/process-host/process-spec'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import { HivewarddBundledRuntimeError } from './hivewardd-bundled-runtime'
import type * as BundledRuntime from './hivewardd-bundled-runtime'
import { resolveHivewarddExitCode } from './hivewardd-exit-code'
import {
  confirmBundledHivewarddStartupQualified,
  discardBundledHivewarddStartupQualification,
  forgetBundledHivewarddStartupQualification,
  preflightBundledHivewarddStartup,
  runHivewarddProfilePreflight
} from './hivewardd-profile-preflight'

const fixture = vi.hoisted(() => ({
  identity: vi.fn(),
  readVersion: vi.fn(),
  sql: vi.fn(),
  native: vi.fn(),
  bundled: vi.fn<(directory: string) => boolean>(),
  run: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
  qualificationKey: vi.fn<(directory: string, version: string) => Promise<string>>(),
  consumeQualification: vi.fn<(directory: string, key: string) => Promise<boolean>>(),
  recordQualification: vi.fn<(directory: string, key: string) => Promise<void>>(),
  discardQualification: vi.fn<(directory: string) => Promise<void>>(),
  qualifiable: vi.fn<(directory: string) => boolean>()
}))
vi.mock('./hivewardd-startup-qualification', () => ({
  hivewarddStartupQualificationKey: fixture.qualificationKey,
  consumeHivewarddStartupQualification: fixture.consumeQualification,
  recordHivewarddStartupQualification: fixture.recordQualification,
  discardHivewarddStartupQualification: fixture.discardQualification,
  isQualifiableHivewarddSlot: fixture.qualifiable
}))
vi.mock('./hivewardd-bundled-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof BundledRuntime>()),
  isRunningAsBundledHivewarddRuntime: fixture.bundled,
  resolveBundledHivewarddSlot: () => '/slot'
}))
vi.mock('./hivewardd-artifact-identity', () => ({ readHivewarddArtifactIdentity: fixture.identity }))
vi.mock('node:fs/promises', () => ({ readFile: fixture.readVersion }))
vi.mock('../persistence/profile-state/profile-state-runtime-preflight', () => ({
  preflightProfileStateRuntime: fixture.sql
}))
vi.mock('./hivewardd-runtime-native-preflight', () => ({
  preflightHivewarddNativeRuntime: fixture.native
}))
vi.mock('@hiveward/process-host', () => ({ runProcess: fixture.run }))

const identity = '0.1.0+aaaaaaaaaaaa'
const nonce = '743bf9c8-2e58-4c79-a0ac-52c8d3e8e103'

function readyResult(challenge: string | undefined): ProcessResult {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    stderr: '',
    stdout: JSON.stringify({
      type: 'hiveward_profile_state_ready',
      nonce: challenge,
      runtime: 'node',
      runtimeVersion: NODE_RUNTIME_PIN.version,
      artifactVersion: identity,
      sqliteVersion: '3.53.2',
      revision: 1
    })
  }
}

beforeEach(() => {
  vi.spyOn(process, 'versions', 'get').mockReturnValue({
    ...process.versions,
    node: NODE_RUNTIME_PIN.version
  })
  fixture.bundled.mockReturnValue(true)
  fixture.identity.mockResolvedValue(identity)
  fixture.readVersion.mockResolvedValue(`${identity}\n`)
  fixture.sql.mockResolvedValue({ sqliteVersion: '3.53.2', revision: 1 })
  fixture.native.mockResolvedValue(undefined)
  fixture.run.mockImplementation(async (spec) => readyResult(spec.args?.[2]))
  fixture.qualificationKey.mockResolvedValue('key-1')
  fixture.consumeQualification.mockResolvedValue(false)
  fixture.recordQualification.mockResolvedValue(undefined)
  fixture.discardQualification.mockResolvedValue(undefined)
  fixture.qualifiable.mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('bundled HiveWard startup readiness', () => {
  it.each(['missing artifact', 'corrupt build target'])(
    'classifies %s as a configuration fault before testing SQLite',
    async (message) => {
      fixture.identity.mockRejectedValue(new Error(message))
      const failure = await runHivewarddProfilePreflight(nonce).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(HivewarddBundledRuntimeError)
      expect(resolveHivewarddExitCode(failure)).toBe(78)
      expect(fixture.sql).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, 'broken-version'])(
    'classifies an unreadable or malformed version marker as configuration: %s',
    async (version) => {
      if (version === undefined) {
        fixture.readVersion.mockRejectedValue(new Error('ENOENT'))
      } else {
        fixture.readVersion.mockResolvedValue(version)
      }
      await expect(preflightBundledHivewarddStartup()).rejects.toThrow(HivewarddBundledRuntimeError)
      expect(fixture.run).not.toHaveBeenCalled()
    }
  )

  it('awaits probe termination before permitting server startup', async () => {
    const exit = Promise.withResolvers<ProcessResult>()
    fixture.run.mockReturnValue(exit.promise)
    let admitted = false
    const startup = preflightBundledHivewarddStartup().then(() => {
      admitted = true
    })
    await vi.waitFor(() => expect(fixture.run).toHaveBeenCalledOnce())
    expect(admitted).toBe(false)
    exit.resolve(readyResult(fixture.run.mock.calls[0]?.[0].args?.[2]))
    await startup
    expect(admitted).toBe(true)
  })

  it.each([{ code: 78 }, { timedOut: true }, { outputTruncated: true }])(
    'refuses a failed child even if it emitted a valid readiness reply: %j',
    async (failure) => {
      fixture.run.mockImplementation(async (spec) => ({
        ...readyResult(spec.args?.[2]),
        ...failure,
        stderr: 'native probe failed'
      }))
      await expect(preflightBundledHivewarddStartup()).rejects.toThrow('native probe failed')
    }
  )

  it('preserves configuration exit status from the isolated child', async () => {
    fixture.run.mockImplementation(async (spec) => ({ ...readyResult(spec.args?.[2]), code: 78 }))
    const failure = await preflightBundledHivewarddStartup().catch((error: unknown) => error)
    expect(resolveHivewarddExitCode(failure)).toBe(78)
  })

  it('keeps transient SQLite readiness failures retryable', async () => {
    fixture.sql.mockRejectedValue(new Error('SQLITE_BUSY'))
    const failure = await runHivewarddProfilePreflight(nonce).catch((error: unknown) => error)
    expect(resolveHivewarddExitCode(failure)).toBe(1)
  })

  it('rejects stale output from a different challenge', async () => {
    fixture.run.mockResolvedValue(readyResult(nonce))
    await expect(preflightBundledHivewarddStartup()).rejects.toThrow('invalid readiness identity')
  })

  it('rechecks the child artifact identity against the verified installed version', async () => {
    fixture.run.mockImplementation(async (spec) => {
      const result = readyResult(spec.args?.[2])
      return { ...result, stdout: result.stdout.replace(identity, '0.1.0+bbbbbbbbbbbb') }
    })
    await expect(preflightBundledHivewarddStartup()).rejects.toThrow('invalid readiness identity')
  })
})

describe('startup qualification on an unchanged host', () => {
  beforeEach(async () => {
    // Drop qualification left pending by an earlier case.
    await confirmBundledHivewarddStartupQualified()
    fixture.recordQualification.mockClear()
  })

  it('skips the preflight child when the last launch with this key reached readiness', async () => {
    fixture.consumeQualification.mockResolvedValue(true)

    await preflightBundledHivewarddStartup()

    expect(fixture.qualificationKey).toHaveBeenCalledWith('/slot', identity)
    expect(fixture.consumeQualification).toHaveBeenCalledWith('/slot', 'key-1')
    expect(fixture.run).not.toHaveBeenCalled()
    expect(fixture.recordQualification).not.toHaveBeenCalled()
    await confirmBundledHivewarddStartupQualified()
    expect(fixture.recordQualification).toHaveBeenCalledExactlyOnceWith('/slot', 'key-1')
  })

  it('records nothing once a launch forgot its qualification (node-pty probe not ok)', async () => {
    await preflightBundledHivewarddStartup()
    forgetBundledHivewarddStartupQualification()
    await confirmBundledHivewarddStartupQualified()

    expect(fixture.recordQualification).not.toHaveBeenCalled()
  })

  it('runs the preflight child without a matching marker, and records only after readiness', async () => {
    await preflightBundledHivewarddStartup()

    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.recordQualification).not.toHaveBeenCalled()
    await confirmBundledHivewarddStartupQualified()
    expect(fixture.recordQualification).toHaveBeenCalledExactlyOnceWith('/slot', 'key-1')
  })

  it('records nothing after a failed preflight, and voids any marker already there', async () => {
    fixture.run.mockImplementation(async (spec) => ({ ...readyResult(spec.args?.[2]), code: 1 }))

    await expect(preflightBundledHivewarddStartup()).rejects.toThrow('failed readiness')
    await confirmBundledHivewarddStartupQualified()

    expect(fixture.recordQualification).not.toHaveBeenCalled()
    expect(fixture.discardQualification).toHaveBeenCalledExactlyOnceWith('/slot')
  })

  it('never reads or writes a marker outside a managed slot', async () => {
    fixture.qualifiable.mockReturnValue(false)
    fixture.consumeQualification.mockResolvedValue(true)

    await preflightBundledHivewarddStartup()
    await confirmBundledHivewarddStartupQualified()

    expect(fixture.qualifiable).toHaveBeenCalledWith('/slot')
    expect(fixture.qualificationKey).not.toHaveBeenCalled()
    expect(fixture.consumeQualification).not.toHaveBeenCalled()
    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.recordQualification).not.toHaveBeenCalled()
  })

  it('falls back to the preflight child, and records nothing, when the key cannot be computed', async () => {
    fixture.qualificationKey.mockRejectedValue(new Error('EACCES'))

    await preflightBundledHivewarddStartup()
    await confirmBundledHivewarddStartupQualified()

    expect(fixture.consumeQualification).not.toHaveBeenCalled()
    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.recordQualification).not.toHaveBeenCalled()
  })

  it('always runs the preflight child on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    fixture.consumeQualification.mockResolvedValue(true)

    // A matching marker never qualifies a Windows slot, so its node-pty probe runs too.
    await expect(preflightBundledHivewarddStartup()).resolves.toBe(false)
    await confirmBundledHivewarddStartupQualified()

    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.recordQualification).not.toHaveBeenCalled()
  })

  it('discards the slot marker after node-pty fails to load, and records nothing for this launch', async () => {
    fixture.consumeQualification.mockResolvedValue(true)
    await preflightBundledHivewarddStartup()

    await discardBundledHivewarddStartupQualification()
    await confirmBundledHivewarddStartupQualified()

    expect(fixture.discardQualification).toHaveBeenCalledExactlyOnceWith('/slot')
    expect(fixture.recordQualification).not.toHaveBeenCalled()
  })

  it('unlinks the marker only after an in-flight record has renamed it into place', async () => {
    const order: string[] = []
    const record = Promise.withResolvers<void>()
    fixture.recordQualification.mockImplementation(async () => {
      await record.promise
      order.push('recorded')
    })
    fixture.discardQualification.mockImplementation(async () => {
      order.push('discarded')
    })
    await preflightBundledHivewarddStartup()

    const confirming = confirmBundledHivewarddStartupQualified()
    const discarding = discardBundledHivewarddStartupQualification()
    await Promise.resolve()
    expect(order).toEqual([])
    record.resolve()
    await Promise.all([confirming, discarding])

    expect(order).toEqual(['recorded', 'discarded'])
  })

  it('never skips the version check, which runs before any marker is read', async () => {
    fixture.readVersion.mockRejectedValue(new Error('ENOENT'))
    fixture.consumeQualification.mockResolvedValue(true)

    await expect(preflightBundledHivewarddStartup()).rejects.toThrow(HivewarddBundledRuntimeError)
    expect(fixture.consumeQualification).not.toHaveBeenCalled()
  })
})
