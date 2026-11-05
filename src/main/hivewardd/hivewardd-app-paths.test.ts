import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveHivewarddInstallRoot } from './hivewardd-app-paths'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.unstubAllEnvs()
})

describe('resolveHivewarddInstallRoot', () => {
  // Bundle siblings live beside symlink targets, not the link.
  it.skipIf(process.platform === 'win32')('follows a symlinked script to the real bundle', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hivewardd-install-root-')))
    try {
      const bundle = join(root, 'slot')
      const bin = join(root, 'bin')
      mkdirSync(bundle)
      mkdirSync(bin)
      writeFileSync(join(bundle, 'hivewardd.js'), '')
      symlinkSync(join(bundle, 'hivewardd.js'), join(bin, 'hivewardd'))
      expect(resolveHivewarddInstallRoot(join(bin, 'hivewardd'))).toBe(bundle)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses instead of guessing when the process has no main script', () => {
    const originalArgv = process.argv
    // node -e omits argv[1]; cwd cannot establish the install root.
    process.argv = [process.execPath]
    try {
      expect(() => resolveHivewarddInstallRoot()).toThrow(/hivewardd_install_root_unavailable/)
    } finally {
      process.argv = originalArgv
    }
  })
})
