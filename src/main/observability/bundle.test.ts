import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _internalsForTests, collectBundle, generateBundleSubmissionId } from './bundle'

let dir: string
let traceFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hiveward-bundle-'))
  traceFile = join(dir, 'main.trace.ndjson')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeNDJSON(records: unknown[]): string {
  return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
}

function makeSpan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = BigInt(Date.now()) * 1_000_000n
  return {
    type: 'effect-span',
    name: 'test',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    kind: 'internal',
    startTimeUnixNano: String(now - 1_000_000_000n),
    endTimeUnixNano: String(now),
    durationMs: 1,
    attributes: {},
    events: [],
    exit: { _tag: 'Success' },
    ...overrides
  }
}

describe('bundle — submission ID', () => {
  it('is base64url, 22 chars (128 bits)', () => {
    const id = generateBundleSubmissionId()
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })
  it('is unique across many calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateBundleSubmissionId())
    }
    expect(ids.size).toBe(100)
  })
})

describe('bundle — collection', () => {
  it.each([
    { kind: 'empty', names: [] },
    { kind: 'ASCII', names: ['plain'] },
    { kind: 'Unicode', names: ['漢字🙂', '\ud800'] },
    {
      kind: 'capped',
      names: Array.from({ length: 600 }, () => '漢字🙂'.repeat(1000))
    }
  ])('reports the exact UTF-8 payload size for $kind records', ({ names }) => {
    writeFileSync(traceFile, makeNDJSON(names.map((name) => makeSpan({ name }))))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 1,
      appVersion: '1',
      platform: 'win32',
      arch: 'x64',
      osRelease: 'test',
      hivewardChannel: 'dev'
    })
    expect(bundle.bytes).toBe(Buffer.byteLength(bundle.payload))
  })

  it('emits a header line with bundle_submission_id, app_version, platform', () => {
    writeFileSync(traceFile, makeNDJSON([makeSpan()]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.0.0',
      hivewardChannel: 'dev'
    })
    const header = JSON.parse(bundle.payload.split('\n').find(Boolean) ?? '')
    expect(header.type).toBe('bundle-header')
    expect(header.bundle_submission_id).toBe(bundle.bundleSubmissionId)
    expect(header.app_version).toBe('1.2.3')
    expect(header.platform).toBe('darwin')
    expect(header.arch).toBe('arm64')
    expect(header.hiveward_channel).toBe('dev')
    expect(header.schema_version).toBe(1)
  })

  it('NEVER carries install_id in the header (Issue 8)', () => {
    writeFileSync(traceFile, makeNDJSON([makeSpan()]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1.0',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })
    const header = JSON.parse(bundle.payload.split('\n')[0])
    expect(header).not.toHaveProperty('install_id')
    expect(header).not.toHaveProperty('installId')
    expect(header).not.toHaveProperty('distinct_id')
  })

  it('reads spans from the rotated family', () => {
    writeFileSync(traceFile, makeNDJSON([makeSpan({ name: 'a' })]))
    writeFileSync(`${traceFile}.1`, makeNDJSON([makeSpan({ name: 'b' })]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })
    expect(bundle.spanCount).toBe(2)
  })

  it('drops spans older than the lookback window', () => {
    const oldNanos = BigInt(Date.now() - 60 * 60 * 1000) * 1_000_000n
    writeFileSync(
      traceFile,
      makeNDJSON([
        makeSpan({ name: 'recent' }),
        makeSpan({
          name: 'old',
          startTimeUnixNano: String(oldNanos - 1n),
          endTimeUnixNano: String(oldNanos)
        })
      ])
    )
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      lookbackMinutes: 30,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })
    expect(bundle.spanCount).toBe(1)
    expect(bundle.payload).toContain('"name":"recent"')
    expect(bundle.payload).not.toContain('"name":"old"')
  })

  it('merges the daemon lifecycle log, bounded by the same lookback', () => {
    const daemonFile = join(dir, 'daemon.log')
    writeFileSync(traceFile, makeNDJSON([makeSpan({ name: 'recent' })]))
    writeFileSync(
      daemonFile,
      makeNDJSON([
        {
          src: 'daemon',
          ts: new Date().toISOString(),
          pid: 1,
          event: 'startup'
        },
        {
          src: 'daemon',
          ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          pid: 1,
          event: 'session-exited'
        }
      ])
    )
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      daemonLogFilePath: daemonFile,
      daemonLogMaxFiles: 3,
      lookbackMinutes: 30,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })
    expect(bundle.payload).toContain('"event":"startup"')
    expect(bundle.payload).toContain('"name":"recent"')
    expect(bundle.payload).not.toContain('"event":"session-exited"')
  })

  it('keeps daemon log lines when trace spans alone would fill the cap', () => {
    const daemonFile = join(dir, 'daemon.log')
    const filler = 'x'.repeat(4096)
    writeFileSync(
      traceFile,
      makeNDJSON(Array.from({ length: 1500 }, () => makeSpan({ name: 'git.exec', filler })))
    )
    writeFileSync(
      daemonFile,
      makeNDJSON([
        {
          src: 'daemon',
          ts: new Date().toISOString(),
          pid: 1,
          event: 'session-created'
        }
      ])
    )
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      daemonLogFilePath: daemonFile,
      daemonLogMaxFiles: 3,
      appVersion: '1',
      platform: 'win32',
      arch: 'x64',
      osRelease: 'test',
      hivewardChannel: 'stable'
    })
    expect(bundle.payload).toContain('"event":"session-created"')
    expect(bundle.payload).toContain('"name":"git.exec"')
    expect(bundle.bytes).toBe(Buffer.byteLength(bundle.payload))
    expect(bundle.bytes).toBeLessThanOrEqual(_internalsForTests.MAX_BUNDLE_BYTES)
    expect(bundle.bytes).toBeGreaterThan(_internalsForTests.MAX_BUNDLE_BYTES - 8192)
  })

  it('gives the daemon log whatever quiet traces leave unused', () => {
    const daemonFile = join(dir, 'daemon.log')
    writeFileSync(traceFile, makeNDJSON([makeSpan({ name: 'recent' })]))
    const detail = 'd'.repeat(1024)
    writeFileSync(
      daemonFile,
      makeNDJSON(
        Array.from({ length: 3000 }, (_, index) => ({
          src: 'daemon',
          ts: new Date().toISOString(),
          pid: 1,
          event: `session-attached-${index}`,
          detail
        }))
      )
    )
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      daemonLogFilePath: daemonFile,
      daemonLogMaxFiles: 3,
      appVersion: '1',
      platform: 'win32',
      arch: 'x64',
      osRelease: 'test',
      hivewardChannel: 'stable'
    })
    expect(bundle.payload).toContain('"name":"recent"')
    // The daemon share is a floor, not a cap.
    expect(bundle.payload).toContain('"event":"session-attached-0"')
    expect(bundle.payload).toContain('"event":"session-attached-2999"')
    expect(bundle.bytes).toBe(Buffer.byteLength(bundle.payload))
    expect(bundle.bytes).toBeLessThanOrEqual(_internalsForTests.MAX_BUNDLE_BYTES)
  })

  it('keeps the newest daemon share when both sources overflow the cap', () => {
    const daemonFile = join(dir, 'daemon.log')
    const filler = 'x'.repeat(4096)
    writeFileSync(
      traceFile,
      makeNDJSON(Array.from({ length: 1500 }, () => makeSpan({ name: 'git.exec', filler })))
    )
    const detail = 'd'.repeat(1024)
    writeFileSync(
      daemonFile,
      makeNDJSON(
        Array.from({ length: 6000 }, (_, index) => ({
          src: 'daemon',
          ts: new Date().toISOString(),
          pid: 1,
          event: `session-attached-${index}`,
          detail
        }))
      )
    )
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      daemonLogFilePath: daemonFile,
      daemonLogMaxFiles: 3,
      appVersion: '1',
      platform: 'win32',
      arch: 'x64',
      osRelease: 'test',
      hivewardChannel: 'stable'
    })
    const daemonBytes = bundle.payload
      .split('\n')
      .filter((line) => line.includes('"src":"daemon"'))
      .reduce((total, line) => total + Buffer.byteLength(line) + 1, 0)
    expect(bundle.payload).toContain('"name":"git.exec"')
    expect(bundle.payload).toContain('"event":"session-attached-5999"')
    expect(daemonBytes).toBeGreaterThan(_internalsForTests.DAEMON_LOG_BUDGET_BYTES - 4096)
    expect(daemonBytes).toBeLessThan(_internalsForTests.DAEMON_LOG_BUDGET_BYTES + 8192)
    expect(bundle.bytes).toBeLessThanOrEqual(_internalsForTests.MAX_BUNDLE_BYTES)
  })

  it('collects no daemon log lines when no daemon log path is given', () => {
    writeFileSync(traceFile, makeNDJSON([makeSpan({ name: 'recent' })]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })
    expect(bundle.payload).not.toContain('"src":"daemon"')
  })

  it('runs the redactor on the merged payload (belt-and-suspenders)', () => {
    const span = makeSpan({
      attributes: {
        leaked: `sk-ant-api03-${'a'.repeat(50)}`
      }
    })
    writeFileSync(traceFile, makeNDJSON([span]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })
    expect(bundle.payload).not.toContain('sk-ant-api03-aaaaa')
    expect(bundle.payload).toContain('[redacted:anthropic-key]')
  })

  it('uses server-mode structured redaction for nested auth and identity keys', () => {
    writeFileSync(
      traceFile,
      makeNDJSON([
        makeSpan({
          attributes: {
            install_id: 'posthog-install-id',
            request: {
              headers: {
                authorization: 'Bearer plain-secret',
                cookie: 'sid=plain-secret',
                keep: 'ok'
              }
            }
          }
        })
      ])
    )
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })
    expect(bundle.payload).not.toContain('posthog-install-id')
    expect(bundle.payload).not.toContain('plain-secret')
    expect(bundle.payload).not.toContain('authorization')
    expect(bundle.payload).not.toContain('cookie')
    expect(bundle.payload).toContain('"keep":"ok"')
  })

  it('does not append a span that would push the payload over the upload cap', () => {
    const giantSpan = makeSpan({
      attributes: {
        message: 'x'.repeat(_internalsForTests.MAX_BUNDLE_BYTES)
      }
    })
    writeFileSync(traceFile, makeNDJSON([giantSpan]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })
    expect(bundle.bytes).toBeLessThanOrEqual(_internalsForTests.MAX_BUNDLE_BYTES)
    expect(bundle.spanCount).toBe(0)
  })

  it('keeps the newest spans when the bundle size cap truncates a file', () => {
    const oldSpan = makeSpan({
      name: 'oldest',
      attributes: { message: 'x'.repeat(_internalsForTests.MAX_BUNDLE_BYTES) }
    })
    const newSpan = makeSpan({
      name: 'newest',
      attributes: { message: 'recent crash' }
    })
    writeFileSync(traceFile, makeNDJSON([oldSpan, newSpan]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })
    expect(bundle.payload).toContain('"name":"newest"')
    expect(bundle.payload).not.toContain('"name":"oldest"')
  })

  it('skips individually oversized recent spans and keeps smaller recent context', () => {
    const tooLargeSpan = makeSpan({
      name: 'oversized',
      attributes: { message: 'x'.repeat(_internalsForTests.MAX_BUNDLE_BYTES) }
    })
    const usefulSpan = makeSpan({
      name: 'useful',
      attributes: { message: 'still useful' }
    })
    writeFileSync(traceFile, makeNDJSON([usefulSpan, tooLargeSpan]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })
    expect(bundle.payload).toContain('"name":"useful"')
    expect(bundle.payload).not.toContain('"name":"oversized"')
  })

  it('skips oversized middle spans after accepting newer context', () => {
    const olderUseful = makeSpan({
      name: 'older-useful',
      attributes: { message: 'older context' }
    })
    const oversizedMiddle = makeSpan({
      name: 'oversized-middle',
      attributes: { message: 'x'.repeat(_internalsForTests.MAX_BUNDLE_BYTES) }
    })
    const newestUseful = makeSpan({
      name: 'newest-useful',
      attributes: { message: 'new context' }
    })
    writeFileSync(traceFile, makeNDJSON([olderUseful, oversizedMiddle, newestUseful]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })
    expect(bundle.payload).toContain('"name":"newest-useful"')
    expect(bundle.payload).toContain('"name":"older-useful"')
    expect(bundle.payload).not.toContain('"name":"oversized-middle"')
  })

  it('skips malformed (non-JSON) lines without throwing', () => {
    writeFileSync(traceFile, [JSON.stringify(makeSpan()), 'not json', ''].join('\n'))
    expect(() =>
      collectBundle({
        traceFilePath: traceFile,
        maxFiles: 10,
        appVersion: '1',
        platform: 'darwin',
        arch: 'arm64',
        osRelease: '24',
        hivewardChannel: 'dev'
      })
    ).not.toThrow()
  })

  it('skips valid JSON lines that are not span objects without throwing', () => {
    writeFileSync(
      traceFile,
      [JSON.stringify(makeSpan({ name: 'valid' })), 'null', '"string"', '42', '[1]', ''].join('\n')
    )
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      hivewardChannel: 'dev'
    })

    expect(bundle.spanCount).toBe(1)
    expect(bundle.payload).toContain('"name":"valid"')
  })
})
