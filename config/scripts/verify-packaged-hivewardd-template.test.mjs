import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME,
  HIVEWARDD_TEMPLATE_MANIFEST_FILENAME,
  HIVEWARDD_TEMPLATE_TARGETS_DIR
} from '../../src/shared/hivewardd-artifacts.ts'
import { NODE_RUNTIME_ASSETS } from '../../src/shared/node-runtime-pin.ts'
import { writeHivewarddTemplateTestFixture } from './hivewardd-template-test-fixture.mjs'

const require = createRequire(import.meta.url)
const { verifyPackagedHivewarddTemplate } = require('./verify-packaged-hivewardd-template.cjs')
const builderConfig = require('../electron-builder.config.cjs')
const roots = []

async function createFixture(options) {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-packaged-hivewardd-template-'))
  roots.push(root)
  const templateDir = await writeHivewarddTemplateTestFixture(root, options)
  return { root, templateDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verifyPackagedHivewarddTemplate', () => {
  it('accepts the complete packaged template', async () => {
    const fixture = await createFixture()

    expect(() => verifyPackagedHivewarddTemplate(fixture.root)).not.toThrow()
  })

  it('accepts the optional rung B compat target beside the default ones', async () => {
    const fixture = await createFixture({ compat: true })

    expect(() => verifyPackagedHivewarddTemplate(fixture.root)).not.toThrow()
  })

  it('rejects a compat target whose runtime reference names the default Node', async () => {
    const fixture = await createFixture({ compat: true })
    await writeFile(
      join(
        fixture.templateDir,
        HIVEWARDD_TEMPLATE_TARGETS_DIR,
        'linux-x64-glibc217',
        HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME
      ),
      `${NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256}\n`
    )

    expect(() => verifyPackagedHivewarddTemplate(fixture.root)).toThrow(
      /linux-x64-glibc217 .*(checksum mismatch|runtime reference)/
    )
  })

  it('rejects a page asset changed after manifest generation', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.templateDir, 'out/mobile-web/index.html'), 'mutated')

    expect(() => verifyPackagedHivewarddTemplate(fixture.root)).toThrow(
      'out/mobile-web/index.html checksum mismatch'
    )
  })

  it('rejects a template whose inventory omits an asset the page lists', async () => {
    const fixture = await createFixture()
    const manifestPath = join(fixture.templateDir, HIVEWARDD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    delete manifest.commonSha256['out/mobile-web/index.html']
    await writeFile(manifestPath, JSON.stringify(manifest))

    expect(() => verifyPackagedHivewarddTemplate(fixture.root)).toThrow('common manifest inventory')
  })

  it('rejects target-native bytes changed after manifest generation', async () => {
    const fixture = await createFixture()
    await writeFile(
      join(
        fixture.templateDir,
        HIVEWARDD_TEMPLATE_TARGETS_DIR,
        'linux-x64-glibc',
        'node_modules/node-pty/build/Release/pty.node'
      ),
      'mutated'
    )

    expect(() => verifyPackagedHivewarddTemplate(fixture.root)).toThrow(
      'linux-x64-glibc node_modules/node-pty/build/Release/pty.node checksum mismatch'
    )
  })

  it('rejects a target whose runtime reference names another Node', async () => {
    const fixture = await createFixture()
    const markerPath = join(
      fixture.templateDir,
      HIVEWARDD_TEMPLATE_TARGETS_DIR,
      'darwin-arm64',
      HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME
    )
    await writeFile(markerPath, `${'0'.repeat(64)}\n`)
    const manifestPath = join(fixture.templateDir, HIVEWARDD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.targets['darwin-arm64'].files[HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME] = createHash(
      'sha256'
    )
      .update(`${'0'.repeat(64)}\n`)
      .digest('hex')
    await writeFile(manifestPath, JSON.stringify(manifest))

    expect(() => verifyPackagedHivewarddTemplate(fixture.root)).toThrow(
      'darwin-arm64 runtime reference disagrees'
    )
  })

  it('rejects a stray Bun-era file in a target directory', async () => {
    const fixture = await createFixture()
    await writeFile(
      join(fixture.templateDir, HIVEWARDD_TEMPLATE_TARGETS_DIR, 'linux-x64-musl', '.build-target'),
      'linux-x64-musl\n'
    )

    expect(() => verifyPackagedHivewarddTemplate(fixture.root)).toThrow(
      'linux-x64-musl file inventory mismatch'
    )
  })

  it.each(['writer', 'backup'])(
    'requires the profile %s worker and its exact bytes',
    async (role) => {
      const fixture = await createFixture()
      const filename = `profile-state-${role}-worker-entry.js`
      await writeFile(join(fixture.templateDir, filename), 'stale-worker')
      expect(() => verifyPackagedHivewarddTemplate(fixture.root)).toThrow(
        `${filename} checksum mismatch`
      )
      await rm(join(fixture.templateDir, filename))
      expect(() => verifyPackagedHivewarddTemplate(fixture.root)).toThrow(`missing ${filename}`)
    }
  )

  it('rejects a missing target before the package reaches deployment', async () => {
    const fixture = await createFixture()
    const manifestPath = join(fixture.templateDir, HIVEWARDD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    delete manifest.targets['linux-arm64-musl']
    await writeFile(manifestPath, JSON.stringify(manifest))

    expect(() => verifyPackagedHivewarddTemplate(fixture.root)).toThrow(
      'target manifest inventory mismatch'
    )
  })

  it('verifies a partial template only against the targets it was built for', async () => {
    const fixture = await createFixture()
    const kept = ['linux-x64-glibc', 'linux-x64-musl']
    const manifestPath = join(fixture.templateDir, HIVEWARDD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const target of Object.keys(manifest.targets).filter((name) => !kept.includes(name))) {
      delete manifest.targets[target]
      await rm(join(fixture.templateDir, HIVEWARDD_TEMPLATE_TARGETS_DIR, target), { recursive: true })
    }
    await writeFile(manifestPath, JSON.stringify(manifest))

    expect(() => verifyPackagedHivewarddTemplate(fixture.root, kept)).not.toThrow()
    expect(() => verifyPackagedHivewarddTemplate(fixture.root)).toThrow(
      'target manifest inventory mismatch'
    )
    expect(() => verifyPackagedHivewarddTemplate(fixture.root, ['linux-x64-glibc'])).toThrow(
      'target manifest inventory mismatch'
    )
  })

  // Desktop must carry deployment template on every OS: SSH/managed deploys materialize target slot from resourcesPath (D2).
  it('ships the deployment template as a resource on every desktop OS, never its runtimes', async () => {
    for (const platform of ['win', 'mac', 'linux']) {
      expect(builderConfig[platform].extraResources).toContainEqual({
        from: 'out/hivewardd-template',
        to: 'hivewardd-template'
      })
      // electron-builder's copy filter drops a source's root node_modules, so it needs its own entry.
      expect(builderConfig[platform].extraResources).toContainEqual({
        from: 'out/hivewardd-template/node_modules',
        to: 'hivewardd-template/node_modules'
      })
      expect(
        builderConfig[platform].extraResources.some(
          (resource) =>
            typeof resource === 'object' && /runtimes|node-runtime-cache/.test(resource.from)
        )
      ).toBe(false)
    }
    // The pinned Node a local build references is ~120 MB and is downloaded on demand instead.
    expect(builderConfig.files).toEqual(
      expect.arrayContaining([
        '!out/hivewardd{,/**/*}',
        '!out/hivewardd-*{,/**/*}',
        '!out/runtimes{,/**/*}',
        '!out/node-runtime-cache{,/**/*}'
      ])
    )
    expect(builderConfig.mac.signIgnore).toContain('/hivewardd-template/')
    // Release CI builds the template from every lane's slot; one host cannot build it alone.
    const { scripts } = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))
    for (const name of ['build:desktop', 'build:release', 'build:release:parallel']) {
      expect(scripts[name]).not.toContain('build:hivewardd-template')
    }
  })
})
