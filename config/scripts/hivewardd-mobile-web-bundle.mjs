import { cpSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  HIVEWARDD_MOBILE_WEB_DIR,
  HIVEWARDD_MOBILE_WEB_MANIFEST,
  hivewarddMobileWebAssetFilenames
} from '../../src/shared/hivewardd-artifacts.ts'

const { MOBILE_WEB_BUNDLE_DIR, assertMobileWebBundleBuilt } = createRequire(import.meta.url)(
  './verify-packaged-mobile-web-bundle.cjs'
)
const { assertNoDarkOutputOfOffSwitches } = createRequire(import.meta.url)(
  '../dark-build-switches.cjs'
)

// Require a fresh built page as beforePack does: an hivewardd package without it cannot serve phones.
export function stageHivewarddMobileWebBundle(outputDir, bundleDir = MOBILE_WEB_BUNDLE_DIR) {
  // The release template refuses the variable itself.
  assertNoDarkOutputOfOffSwitches([bundleDir])
  assertMobileWebBundleBuilt(bundleDir)
  // The guard refuses unlisted files, so the tree is the manifest, its assets and a dark marker.
  cpSync(bundleDir, join(outputDir, ...HIVEWARDD_MOBILE_WEB_DIR.split('/')), { recursive: true })
}

export function readHivewarddMobileWebAssetFilenames(packageDir) {
  return hivewarddMobileWebAssetFilenames(
    readFileSync(join(packageDir, ...HIVEWARDD_MOBILE_WEB_MANIFEST.split('/')), 'utf8')
  )
}
