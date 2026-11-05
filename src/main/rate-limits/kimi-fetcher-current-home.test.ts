import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as NodeOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'

const homeState = vi.hoisted(() => ({ dir: '' }))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => homeState.dir
}))

import { fetchKimiRateLimits } from './kimi-fetcher'

const fetchMock = vi.fn()
setMainHttpClient({ fetch: fetchMock, proxySession: () => null })

function writeCredentials(kimiHome: string, token: string, expiresInSeconds: number): void {
  mkdirSync(join(kimiHome, 'credentials'), { recursive: true })
  writeFileSync(
    join(kimiHome, 'credentials', 'kimi-code.json'),
    JSON.stringify({
      access_token: token,
      refresh_token: 'refresh',
      expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
      token_type: 'Bearer'
    })
  )
}

function usageResponse(): Response {
  return new Response(
    JSON.stringify({
      usage: { limit: '1000', remaining: '1000', resetTime: '2026-06-09T07:52:41.230862Z' },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '100', remaining: '0', resetTime: '2026-06-04T08:52:41.230862Z' }
        }
      ]
    }),
    { status: 200 }
  )
}

describe('fetchKimiRateLimits host home selection', () => {
  beforeEach(() => {
    homeState.dir = mkdtempSync(join(NodeOs.tmpdir(), 'kimi-home-'))
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(usageResponse())
    vi.stubEnv('KIMI_CODE_HOME', '')
    vi.stubEnv('KIMI_SHARE_DIR', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(homeState.dir, { recursive: true, force: true })
  })

  // Current CLI signs in under ~/.kimi while a fresh ~/.kimi-code install has only config.toml.
  it('reads ~/.kimi credentials when the legacy ~/.kimi-code home has none', async () => {
    const legacy = join(homeState.dir, '.kimi-code')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'config.toml'), '[[hooks]]\nevent = "Stop"\ncommand = "true"\n')
    const current = join(homeState.dir, '.kimi')
    writeCredentials(current, 'current-token', 15 * 60)
    writeFileSync(
      join(current, 'config.toml'),
      '[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "https://api.kimi.com/coding/v1"\n'
    )

    const result = await fetchKimiRateLimits({
      home: { runtime: 'host', wslDistro: null, path: legacy }
    })

    expect(result.status).toBe('ok')
    expect(result.session).toMatchObject({
      usedPercent: 100,
      windowMinutes: 300,
      resetsAt: Date.parse('2026-06-04T08:52:41.230862Z')
    })
    expect(result.weekly).toMatchObject({ usedPercent: 0, windowMinutes: 10080 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.kimi.com/coding/v1/usages')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer current-token')
  })

  it('still reads legacy ~/.kimi-code credentials when ~/.kimi has none', async () => {
    const legacy = join(homeState.dir, '.kimi-code')
    writeCredentials(legacy, 'legacy-token', 15 * 60)

    const result = await fetchKimiRateLimits({
      home: { runtime: 'host', wslDistro: null, path: legacy }
    })

    expect(result.status).toBe('ok')
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe(
      'Bearer legacy-token'
    )
  })

  it('stays unavailable when neither home has credentials', async () => {
    const result = await fetchKimiRateLimits({
      home: { runtime: 'host', wslDistro: null, path: join(homeState.dir, '.kimi-code') }
    })

    expect(result.status).toBe('unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
