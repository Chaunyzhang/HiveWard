import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assembleHivewarddArtifact } from '../../src/main/hivewardd/hivewardd-artifact-materializer.ts'
import { HIVEWARDD_TEMPLATE_MANIFEST_FILENAME } from '../../src/shared/hivewardd-artifacts.ts'
import { writeHivewarddTemplateTestFixture } from './hivewardd-template-test-fixture.mjs'

const require = createRequire(import.meta.url)
const {
  finalizePackagedHivewarddTemplate,
  resealSignedWindowsApp
} = require('./packaged-hivewardd-template.cjs')
const roots = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function packagedApp() {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const appDir = await mkdtemp(join(tmpdir(), 'hiveward-packaged-browser-'))
  roots.push(appDir)
  const resourcesDir = join(appDir, 'resources')
  const templateDir = await writeHivewarddTemplateTestFixture(resourcesDir)
  const driver = join(resourcesDir, 'agent-browser-win32-x64.exe')
  await writeFile(driver, 'desktop driver')
  await finalizePackagedHivewarddTemplate(resourcesDir, { platform: 'win32', signMacBinary: vi.fn() })
  return {
    appDir,
    templateDir,
    driver,
    manifestPath: join(templateDir, HIVEWARDD_TEMPLATE_MANIFEST_FILENAME)
  }
}

describe("packaged hivewardd uses the app's agent-browser driver (#33846)", () => {
  it("materializes the host target's slot with the driver the app ships", async () => {
    const app = await packagedApp()
    const slot = await assembleHivewarddArtifact({
      templateDir: app.templateDir,
      cacheRoot: join(app.appDir, 'cache'),
      target: 'win32-x64'
    })
    expect(await readFile(join(slot, 'agent-browser-win32-x64.exe'), 'utf8')).toBe('desktop driver')
    // A target that carries its own copy keeps it.
    const manifest = JSON.parse(await readFile(app.manifestPath, 'utf8'))
    expect(manifest.targets['linux-x64-glibc'].packagedBrowser).toBeUndefined()
    expect(manifest.targets['win32-arm64'].browserName).toBeUndefined()
  })

  it('reseals the driver after SignPath rewrites it', async () => {
    const app = await packagedApp()
    await writeFile(app.driver, 'authenticode-signed driver')
    const list = join(app.appDir, 'inner-signing-list.txt')
    await writeFile(list, 'HiveWard.exe\r\nresources\\agent-browser-win32-x64.exe\r\n')
    resealSignedWindowsApp(app.appDir, list)
    const slot = await assembleHivewarddArtifact({
      templateDir: app.templateDir,
      cacheRoot: join(app.appDir, 'cache'),
      target: 'win32-x64'
    })
    expect(await readFile(join(slot, 'agent-browser-win32-x64.exe'), 'utf8')).toBe(
      'authenticode-signed driver'
    )
  })
})
