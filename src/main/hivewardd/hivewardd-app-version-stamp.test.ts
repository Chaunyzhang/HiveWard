import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stampHivewarddAppVersion } from './hivewardd-host-adapters'

describe('the HiveWard version a server reports', () => {
  let root: string
  let saved: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hivewardd-app-version-'))
    saved = process.env.HIVEWARD_APP_VERSION
    delete process.env.HIVEWARD_APP_VERSION
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (saved === undefined) {
      delete process.env.HIVEWARD_APP_VERSION
    } else {
      process.env.HIVEWARD_APP_VERSION = saved
    }
  })

  it('replaces a version inherited from the HiveWard that started it', () => {
    process.env.HIVEWARD_APP_VERSION = '1.4.300'
    mkdirSync(join(root, 'out'), { recursive: true })
    writeFileSync(join(root, 'out', 'package.json'), JSON.stringify({ version: '1.4.224' }))
    stampHivewarddAppVersion(() => root)
    expect(process.env.HIVEWARD_APP_VERSION).toBe('1.4.224')
  })

  it('leaves the environment alone when the bundle has no version', () => {
    stampHivewarddAppVersion(() => root)
    expect(process.env.HIVEWARD_APP_VERSION).toBeUndefined()
    stampHivewarddAppVersion(() => {
      throw new Error('hivewardd_install_root_unavailable')
    })
    expect(process.env.HIVEWARD_APP_VERSION).toBeUndefined()
  })
})
