import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hivewarddDataRootIsOnLocalDisk } from './hivewardd-data-root-locality'

describe('hivewarddDataRootIsOnLocalDisk', () => {
  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'recognises a local temp directory, and refuses a path it cannot inspect',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'hivewardd-locality-'))
      try {
        expect(hivewarddDataRootIsOnLocalDisk(root)).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
      expect(hivewarddDataRootIsOnLocalDisk(join(root, 'missing'))).toBe(false)
    }
  )

  it('treats a Windows UNC data root as reachable from other machines', () => {
    expect(hivewarddDataRootIsOnLocalDisk('\\\\filer\\home\\hiveward', 'win32')).toBe(false)
    expect(hivewarddDataRootIsOnLocalDisk('\\\\?\\UNC\\filer\\home\\hiveward', 'win32')).toBe(false)
    expect(hivewarddDataRootIsOnLocalDisk('C:\\Users\\u\\AppData\\Roaming\\hiveward', 'win32')).toBe(true)
    expect(hivewarddDataRootIsOnLocalDisk('\\\\?\\C:\\Users\\u\\hiveward', 'win32')).toBe(true)
  })
})
