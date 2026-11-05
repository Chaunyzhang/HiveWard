import { describe, expect, it } from 'vitest'
import { getDevInstanceIdentity } from '../../src/main/startup/dev-instance-identity'
import {
  DEV_BUNDLE_DISPLAY_NAME,
  getDevBundlePlistPatches,
  getDevHelperPlistPatches
} from './dev-electron-bundle-identity.mjs'

const BRANCH_ENV_KEYS = [
  'HIVEWARD_DEV_DOCK_TITLE',
  'HIVEWARD_DEV_BRANCH',
  'HIVEWARD_DEV_INSTANCE_LABEL',
  'HIVEWARD_DEV_WORKTREE_NAME'
] as const

/** Collect the patch set as it would be computed on a given branch. */
function patchesUnder(dockTitle: string, branch: string) {
  // Restore env keys individually: replacing process.env loses Node’s string coercion and leaks a plain object into later worker tests.
  const saved = BRANCH_ENV_KEYS.map((key) => [key, process.env[key]] as const)
  Object.assign(process.env, {
    HIVEWARD_DEV_DOCK_TITLE: dockTitle,
    HIVEWARD_DEV_BRANCH: branch,
    HIVEWARD_DEV_INSTANCE_LABEL: branch,
    HIVEWARD_DEV_WORKTREE_NAME: branch
  })
  try {
    return [...getDevBundlePlistPatches(), ...getDevHelperPlistPatches()]
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('dev-electron-bundle-identity', () => {
  it('gives the dev app a legible display name so notifications are not just "Electron"', () => {
    const byKey = Object.fromEntries(
      getDevBundlePlistPatches().map((patch) => [patch.key, patch.value])
    )
    expect(byKey.CFBundleName).toBe(DEV_BUNDLE_DISPLAY_NAME)
    expect(byKey.CFBundleDisplayName).toBe(DEV_BUNDLE_DISPLAY_NAME)
    expect(DEV_BUNDLE_DISPLAY_NAME).not.toBe('Electron')
  })

  it('keeps the bundle display name in step with the name safeStorage keys off', () => {
    // Keep fixed bundle name aligned with app.setName’s Keychain service identity.
    expect(DEV_BUNDLE_DISPLAY_NAME).toBe(getDevInstanceIdentity(true, {}).appName)
  })

  it('produces byte-identical patches on two different branches', () => {
    // Compare full patches across branches: any signed Info.plist drift changes cdhash/Keychain ACL; substring denylists miss ordinary branch names.
    expect(patchesUnder('HiveWard: fix-login-crash', 'fix-login-crash')).toEqual(
      patchesUnder('HiveWard: perf-2', 'perf-2')
    )
    expect(patchesUnder('HiveWard: dev', 'main')).toEqual(
      patchesUnder('HiveWard: some-worktree @ feature/x', 'feature/x')
    )
  })
})
