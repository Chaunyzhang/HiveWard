import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAppUpdatePreferences } from './app-update-preferences'

const stored = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    multiGet: async (keys: string[]) => keys.map((key) => [key, stored.get(key) ?? null])
  }
}))

beforeEach(() => stored.clear())

describe('loadAppUpdatePreferences', () => {
  it('drops only a corrupt update record, keeping the check time and dismissal beside it', async () => {
    stored.set('hiveward:appUpdate:lastCheckedAt', '1700000000000')
    stored.set('hiveward:appUpdate:latest', '{not json')
    stored.set('hiveward:appUpdate:dismissedVersion', '0.0.51')
    await expect(loadAppUpdatePreferences()).resolves.toEqual({
      lastCheckedAt: 1700000000000,
      latest: null,
      dismissedVersion: '0.0.51'
    })
  })

  it('reads a well-formed update record', async () => {
    stored.set(
      'hiveward:appUpdate:latest',
      JSON.stringify({ version: '0.0.52', url: 'https://x.test' })
    )
    await expect(loadAppUpdatePreferences()).resolves.toEqual({
      lastCheckedAt: null,
      latest: { version: '0.0.52', url: 'https://x.test' },
      dismissedVersion: null
    })
  })
})
