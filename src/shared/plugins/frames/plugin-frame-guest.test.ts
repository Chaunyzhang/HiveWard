import { describe, expect, it } from 'vitest'
import {
  isPluginFrameOriginUrl,
  parsePluginFrameUrl,
  pluginFrameKey,
  pluginFramePartition,
  pluginFrameUrl,
  readPluginFramePartitionKey
} from './plugin-frame-guest'

const KEY = pluginFrameKey('acme.charts')

describe('plugin frame guest identity', () => {
  it('round-trips the partition and refuses look-alikes', () => {
    expect(pluginFramePartition(KEY)).toBe(`persist:hiveward-plugin-${KEY}`)
    expect(readPluginFramePartitionKey(pluginFramePartition(KEY))).toBe(KEY)
    expect(readPluginFramePartitionKey(`persist:hiveward-plugin-${KEY}x`)).toBeNull()
    expect(readPluginFramePartitionKey(`hiveward-plugin-${KEY}`)).toBeNull()
    expect(readPluginFramePartitionKey('persist:hiveward-plugin-../../x')).toBeNull()
  })
})

describe('plugin frame URLs', () => {
  it('builds entry URLs from manifest paths', () => {
    expect(pluginFrameUrl(KEY, 'ui/panel.html')).toBe(`hiveward-plugin-frame://${KEY}/ui/panel.html`)
    expect(pluginFrameUrl(KEY, './a b/#x.html')).toBe(`hiveward-plugin-frame://${KEY}/a%20b/%23x.html`)
  })

  it('parses contained paths into decoded segments', () => {
    expect(parsePluginFrameUrl(`hiveward-plugin-frame://${KEY}/ui/app.js?v=1`)).toEqual({
      frameKey: KEY,
      segments: ['ui', 'app.js'],
      reserved: false
    })
    expect(parsePluginFrameUrl(`hiveward-plugin-frame://${KEY}/a%20b/x.wasm`)?.segments).toEqual([
      'a b',
      'x.wasm'
    ])
    expect(parsePluginFrameUrl(`hiveward-plugin-frame://${KEY}/__hiveward/sdk.js`)?.reserved).toBe(true)
    expect(parsePluginFrameUrl(`hiveward-plugin-frame://${KEY}/__HIVEWARD/sdk.js`)?.reserved).toBe(true)
    expect(parsePluginFrameUrl(`hiveward-plugin-frame://${KEY}/__HiveWard/sdk.js`)?.reserved).toBe(true)
  })

  it('lets URL dot segments collapse at the plugin root, never above it', () => {
    expect(
      parsePluginFrameUrl(`hiveward-plugin-frame://${KEY}/ui/%2e%2e/%2e%2e/../secret`)?.segments
    ).toEqual(['secret'])
  })

  it.each([
    `hiveward-plugin-frame://${KEY}/`,
    `hiveward-plugin-frame://${KEY}/..%2Fsecret`,
    `hiveward-plugin-frame://${KEY}/a%5C..%5Cb`,
    `hiveward-plugin-frame://${KEY}/a%00b`,
    `hiveward-plugin-frame://${KEY}/__hiveward./runtime.mjs`,
    `hiveward-plugin-frame://${KEY}/__hiveward%20/runtime.mjs`,
    `hiveward-plugin-frame://${KEY}/panel.html.`,
    `hiveward-plugin-frame://${KEY}/C:%5Cwindows`,
    `hiveward-plugin-frame://${KEY}/bad%E0%A4%A`,
    `hiveward-plugin-frame://${KEY}:8080/x`,
    `hiveward-plugin-frame://user@${KEY}/x`,
    'hiveward-plugin-frame://NOTAKEY/x',
    `https://${KEY}/x`
  ])('refuses %s', (url) => {
    expect(parsePluginFrameUrl(url)).toBeNull()
  })

  it('matches only the exact plugin origin', () => {
    expect(isPluginFrameOriginUrl(`hiveward-plugin-frame://${KEY}/x.html`, KEY)).toBe(true)
    expect(isPluginFrameOriginUrl(`hiveward-plugin-frame://${pluginFrameKey('a.b')}/x`, KEY)).toBe(
      false
    )
    expect(isPluginFrameOriginUrl(`blob:hiveward-plugin-frame://${KEY}/uuid`, KEY)).toBe(false)
    expect(isPluginFrameOriginUrl('not a url', KEY)).toBe(false)
  })
})
