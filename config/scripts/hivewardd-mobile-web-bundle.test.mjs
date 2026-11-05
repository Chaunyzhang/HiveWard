import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HIVEWARDD_MOBILE_WEB_MANIFEST } from '../../src/shared/hivewardd-artifacts.ts'
import { writeMobileWebBundleFixtureTree } from './mobile-web-bundle-fixture-tree.mjs'
import {
  readHivewarddMobileWebAssetFilenames,
  stageHivewarddMobileWebBundle
} from './hivewardd-mobile-web-bundle.mjs'

let scratch
let bundleDir
let outputDir

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hivewardd-mobile-web-'))
  bundleDir = join(scratch, 'mobile-web')
  outputDir = join(scratch, 'hivewardd')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

it('stages the manifest and every asset it lists, byte for byte', async () => {
  const { manifest } = await writeMobileWebBundleFixtureTree({ outDir: bundleDir })
  stageHivewarddMobileWebBundle(outputDir, bundleDir)

  const staged = readHivewarddMobileWebAssetFilenames(outputDir)
  expect(staged).toHaveLength(manifest.assets.length)
  for (const asset of manifest.assets) {
    expect(readFileSync(join(outputDir, 'out', 'mobile-web', asset.path))).toEqual(
      readFileSync(join(bundleDir, asset.path))
    )
  }
  expect(readFileSync(join(outputDir, HIVEWARDD_MOBILE_WEB_MANIFEST))).toEqual(
    readFileSync(join(bundleDir, 'manifest.json'))
  )
})

it('stages a dark page into a dark hivewardd, and refuses it in any other', async () => {
  vi.stubEnv('HIVEWARD_SIDEBAR_INPUTS', 'main')
  await writeMobileWebBundleFixtureTree({ outDir: bundleDir })
  stageHivewarddMobileWebBundle(outputDir, bundleDir)
  expect(existsSync(join(outputDir, HIVEWARDD_MOBILE_WEB_MANIFEST))).toBe(true)

  vi.unstubAllEnvs()
  rmSync(outputDir, { recursive: true, force: true })
  expect(() => stageHivewarddMobileWebBundle(outputDir, bundleDir)).toThrow('HIVEWARD_SIDEBAR_INPUTS=main')
  expect(existsSync(join(outputDir, HIVEWARDD_MOBILE_WEB_MANIFEST))).toBe(false)
})

it('fails the build when the page was never built', () => {
  expect(() => stageHivewarddMobileWebBundle(outputDir, bundleDir)).toThrow('pnpm build:mobile-web')
  expect(existsSync(join(outputDir, HIVEWARDD_MOBILE_WEB_MANIFEST))).toBe(false)
})

it('ships the page the qualification lanes tested in the release template', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/node-server-tests.yml', import.meta.url), 'utf8')
  )
  const template = workflow.jobs.desktop_template
  const wait = template.steps.findIndex(
    (step) => step.name === 'Wait for every template qualification lane'
  )
  expect(template.steps[wait].with.script).toContain('mobile_web_bundle: 1')
  expect(wait).toBeLessThan(
    template.steps.findIndex((step) => step.with?.name === 'hivewardd-mobile-web-bundle')
  )
  expect(template.steps.some((step) => step.with?.name === 'hivewardd-mobile-web-bundle')).toBe(true)
  expect(template.steps.some((step) => step.uses?.includes('build-mobile-web-bundle'))).toBe(false)
})
