import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HIVEWARDD_MOBILE_WEB_MANIFEST,
  HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME,
  HIVEWARDD_SERVER_TARGET_FILENAME,
  hivewarddArtifactFilenames,
  hivewarddRipgrepArtifact
} from '../../src/shared/hivewardd-artifacts.ts'
import { SERVER_TARGETS } from '../../src/shared/node-runtime-pin.ts'
import { hivewarddAgentBrowserNativeName } from '../../src/shared/hivewardd-agent-browser-name.ts'
import { readHivewarddArtifactIdentity } from '../../src/main/hivewardd/hivewardd-artifact-identity.ts'
import { computeHivewarddFullVersion } from './hivewardd-artifact-version.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const PAGE_ASSET = 'out/mobile-web/index.html'
const PAGE_MANIFEST = JSON.stringify({ assets: [{ path: 'index.html' }] })

function createArtifactDirectory(target = 'linux-x64-glibc') {
  const directory = mkdtempSync(join(tmpdir(), 'hivewardd-version-'))
  directories.push(directory)
  for (const filename of hivewarddArtifactFilenames(target, [PAGE_ASSET])) {
    const path = join(directory, filename)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, filename === HIVEWARDD_MOBILE_WEB_MANIFEST ? PAGE_MANIFEST : filename)
  }
  writeFileSync(join(directory, HIVEWARDD_SERVER_TARGET_FILENAME), `${target}\n`)
  return directory
}

describe('standalone runtime version', () => {
  it('changes when a shipped search binary changes and rejects a missing binary', () => {
    const target = 'linux-x64-glibc'
    const dir = createArtifactDirectory(target)
    const before = computeHivewarddFullVersion(dir, { target })
    const binary = join(dir, hivewarddRipgrepArtifact(target))
    writeFileSync(binary, 'updated binary')
    expect(computeHivewarddFullVersion(dir, { target })).not.toBe(before)
    rmSync(binary)
    expect(() => computeHivewarddFullVersion(dir, { target })).toThrow(hivewarddRipgrepArtifact(target))
  })

  it('changes when a page asset changes and rejects a missing one', () => {
    const target = 'linux-x64-glibc'
    const dir = createArtifactDirectory(target)
    const before = computeHivewarddFullVersion(dir, { target })
    writeFileSync(join(dir, PAGE_ASSET), 'updated page')
    expect(computeHivewarddFullVersion(dir, { target })).not.toBe(before)
    rmSync(join(dir, PAGE_ASSET))
    expect(() => computeHivewarddFullVersion(dir, { target })).toThrow(PAGE_ASSET)
  })

  it('keys the version on the referenced runtime digest rather than its bytes', () => {
    const target = 'darwin-arm64'
    const dir = createArtifactDirectory(target)
    writeFileSync(join(dir, HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME), `${'a'.repeat(64)}\n`)
    const before = computeHivewarddFullVersion(dir, { target })
    writeFileSync(join(dir, HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME), `${'b'.repeat(64)}\n`)
    expect(computeHivewarddFullVersion(dir, { target })).not.toBe(before)
  })

  it.each(SERVER_TARGETS)(
    'matches the installed %s identity with and without its optional browser',
    async (target) => {
      const dir = createArtifactDirectory(target)
      const [platform, arch] = target.split('-')
      const agentBrowserFilename = hivewarddAgentBrowserNativeName(
        platform,
        arch,
        target.endsWith('-musl') ? 'musl' : 'glibc'
      )
      const options = { target, agentBrowserFilename }
      const withoutBrowser = computeHivewarddFullVersion(dir, options)
      expect(withoutBrowser).toBe(await readHivewarddArtifactIdentity(dir))
      writeFileSync(join(dir, agentBrowserFilename), 'browser')
      const withBrowser = computeHivewarddFullVersion(dir, options)
      expect(withBrowser).not.toBe(withoutBrowser)
      expect(withBrowser).toBe(await readHivewarddArtifactIdentity(dir))
      writeFileSync(join(dir, agentBrowserFilename), 'updated-browser')
      expect(computeHivewarddFullVersion(dir, options)).not.toBe(withBrowser)
      expect(computeHivewarddFullVersion(dir, options)).toBe(await readHivewarddArtifactIdentity(dir))
    }
  )
})
