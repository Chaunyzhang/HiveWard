import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')

const MUTABLE_BUILD_ENV = [
  'HIVEWARD_MAC_HOURLY',
  'HIVEWARD_MAC_DAILY',
  'HIVEWARD_MAC_ADHOC',
  'HIVEWARD_MAC_RELEASE',
  'HIVEWARD_HOURLY_BUILD_VERSION',
  'HIVEWARD_DAILY_BUILD_VERSION',
  'HIVEWARD_ADHOC_BUILD_VERSION',
  'HIVEWARD_LOCAL_BUILD_VERSION'
]

/** Re-requires the config under a temporary env, then restores env and module cache. */
function withEnv(env, assert) {
  const configPath = require.resolve('../electron-builder.config.cjs')
  const original = Object.fromEntries(MUTABLE_BUILD_ENV.map((key) => [key, process.env[key]]))
  try {
    for (const key of MUTABLE_BUILD_ENV) {
      delete process.env[key]
    }
    Object.assign(process.env, env)
    delete require.cache[configPath]
    assert(require('../electron-builder.config.cjs'))
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    delete require.cache[configPath]
    require('../electron-builder.config.cjs')
  }
}

describe('HiveWard 正式版构建配置', () => {
  it('固定自家正式版发布源与产品身份', () => {
    expect(electronBuilderConfig.appId).toBe('app.hiveward')
    expect(electronBuilderConfig.publish).toEqual({
      provider: 'github',
      owner: 'Chaunyzhang',
      repo: 'HiveWard',
      releaseType: 'release'
    })
    expect(electronBuilderConfig.win.verifyUpdateCodeSignature).toBe(false)
  })
  it.each(['HOURLY', 'DAILY', 'ADHOC'])('忽略继承的 %s 渠道和版号', (channel) => {
    withEnv(
      { [`HIVEWARD_MAC_${channel}`]: '1', [`HIVEWARD_${channel}_BUILD_VERSION`]: '1.4.214-legacy' },
      (config) => {
        expect(config.extraMetadata).toBeUndefined()
        expect(config.mac.notarize).toBe(false)
        expect(config.forceCodeSigning).toBe(false)
        expect(config.publish.repo).toBe('HiveWard')
      }
    )
  })
  it('仍允许明确选择自有签名，普通本地构建不要求证书', () => {
    withEnv({ HIVEWARD_MAC_RELEASE: '1' }, (config) => expect(config.mac.notarize).toBe(true))
    expect(electronBuilderConfig.mac.notarize).toBe(false)
  })
})
