import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HIVEWARDD_VERSION, hivewarddArtifactFilenames } from '../../src/shared/hivewardd-artifacts.ts'
import { readHivewarddMobileWebAssetFilenames } from './hivewardd-mobile-web-bundle.mjs'

/** The runtime enters through `.runtime-node`'s executableSha256 string, never its bytes (design D2). */
export function computeHivewarddFullVersion(artifactDir, { target, agentBrowserFilename }) {
  const hash = createHash('sha256')
  for (const filename of hivewarddArtifactFilenames(
    target,
    readHivewarddMobileWebAssetFilenames(artifactDir)
  )) {
    const artifactPath = join(artifactDir, filename)
    if (!existsSync(artifactPath)) {
      throw new Error(
        `hivewardd declares ${filename} in HIVEWARDD_ARTIFACTS but never emitted it. Add the build ` +
          'step, or drop it from src/shared/hivewardd-artifacts.ts.'
      )
    }
    hash.update(readFileSync(artifactPath))
  }
  if (agentBrowserFilename && existsSync(join(artifactDir, agentBrowserFilename))) {
    hash.update(readFileSync(join(artifactDir, agentBrowserFilename)))
  }
  return `${HIVEWARDD_VERSION}+${hash.digest('hex').slice(0, 12)}`
}
