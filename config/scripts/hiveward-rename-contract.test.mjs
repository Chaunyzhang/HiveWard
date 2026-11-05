import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const builder = require('../electron-builder.config.cjs')

describe('HiveWard 改名安装契约', () => {
  it('新 bundle、新协议与环境变量资源一起打包', () => {
    expect(builder.appId).toBe('app.hiveward')
    expect(builder.protocols[0].schemes).toEqual(['hiveward'])
    const resources = builder.mac.extraResources
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'src/shared/hiveward-environment.mjs',
          to: 'hiveward/shared/environment.mjs'
        })
      ])
    )
  })

  it('Windows 只迁同目录 HiveWard 的旧 GUID，不清理 HiveWard 注册', () => {
    const script = readFileSync(
      new URL('../nsis/hiveward-legacy-install.nsh', import.meta.url),
      'utf8'
    )
    expect(script).toContain('2c9c3646-e621-507d-9f90-0e1a5fa6e28b')
    expect(script).toContain('$0 == "$INSTDIR"')
    expect(script).toContain('$1 == "HiveWard"')
    expect(script).toContain('$2 == "HiveWard"')
    expect(script).not.toContain('app.hiveward')
    expect(script.indexOf('HIVEWARD_LEGACY_BACKUP')).toBeLessThan(script.indexOf('DeleteRegKey'))
  })
})
