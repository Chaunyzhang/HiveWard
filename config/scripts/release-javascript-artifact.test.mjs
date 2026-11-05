import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@hiveward/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import {
  javascriptInventory,
  packReleaseJavascript,
  releaseBuildIdentity,
  releaseJavascriptConfiguration,
  restoreReleaseJavascript
} from './release-javascript-artifact.mjs'

const directories = []
const configuration = {
  sourceSha: 'a'.repeat(40),
  version: '1.2.3-rc.4',
  packageManager: 'pnpm@12.14.0',
  identity: 'rc',
  diagnosticsTokenUrl: 'https://example.test/diagnostics',
  telemetryKeySha256: 'b'.repeat(64)
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hiveward-release-javascript-test-'))
  directories.push(root)
  for (const file of [
    'cli/index.js',
    'main/index.js',
    'preload/index.js',
    'renderer/index.html',
    'renderer/.vite/manifest.json',
    'renderer/.hiveward-web-client-files.json',
    'web/web-index.html',
    'mobile-web/manifest.json',
    'package.json',
    'renderer/wasm/viewer.wasm',
    'main/index.js.map'
  ]) {
    const destination = join(root, 'out', file)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, file === 'cli/index.js' ? '#!/usr/bin/env node\n' : file)
  }
  const artifactDir = join(root, '.build', 'artifact')
  return { root, artifactDir, configuration }
}

function configurationFixture(version = '1.2.3') {
  const root = mkdtempSync(join(tmpdir(), 'hiveward-javascript-configuration-test-'))
  directories.push(root)
  const hooks = join(root, 'empty-hooks')
  mkdirSync(hooks)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ version, packageManager: 'pnpm@12.14.0' })
  )
  for (const args of [
    ['init', '--quiet'],
    [
      '-c',
      'user.name=Build test',
      '-c',
      'user.email=build@example.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${hooks}`,
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'Build fixture'
    ]
  ]) {
    const result = runProcessSync({ program: 'git', args, cwd: root, timeoutMs: 10_000 })
    expect(result.code, result.stderr).toBe(0)
  }
  const env = {
    HIVEWARD_BUILD_IDENTITY: 'stable',
    HIVEWARD_DIAGNOSTICS_TOKEN_URL: 'https://example.test/diagnostics',
    HIVEWARD_POSTHOG_WRITE_KEY: 'release-key'
  }
  return { root, env }
}

describe('release JavaScript configuration', () => {
  it.each([
    ['1.2.3', 'stable'],
    ['1.2.3-rc.4.perf', 'rc']
  ])('保留 %s 的版本和构建身份校验，不依赖 Stably 配置', (version, identity) => {
    const { root, env } = configurationFixture(version)
    const result = releaseJavascriptConfiguration(root, {
      ...env,
      HIVEWARD_BUILD_IDENTITY: identity,
      HIVEWARD_POSTHOG_WRITE_KEY: '',
      HIVEWARD_DIAGNOSTICS_TOKEN_URL: ''
    })
    expect(result).toMatchObject({ identity, version, packageManager: 'pnpm@12.14.0' })
    expect(result.sourceSha).toMatch(/^[a-f0-9]{40}$/)
    expect(result).not.toHaveProperty('telemetryKeySha256')
    expect(result).not.toHaveProperty('diagnosticsTokenUrl')
  })

  it('开发构建仍要求显式身份，拒绝冒充正式构建', () => {
    const { root, env } = configurationFixture('0.0.0-adhoc.test')
    const devEnv = {
      ...env,
      HIVEWARD_RELEASE_JAVASCRIPT_BUILD_IDENTITY: 'dev',
      HIVEWARD_BUILD_IDENTITY: ''
    }
    expect(releaseJavascriptConfiguration(root, devEnv)).toMatchObject({ identity: 'dev' })
    expect(() =>
      releaseJavascriptConfiguration(root, { ...devEnv, HIVEWARD_BUILD_IDENTITY: 'stable' })
    ).toThrow('must not set an official build identity')
    expect(() =>
      releaseJavascriptConfiguration(root, {
        ...devEnv,
        HIVEWARD_RELEASE_JAVASCRIPT_BUILD_IDENTITY: ''
      })
    ).toThrow('Invalid desktop release tag')
  })

  it('缺少或不匹配的正式构建身份仍然报错', () => {
    const { root, env } = configurationFixture()
    expect(() => releaseJavascriptConfiguration(root, { ...env, HIVEWARD_BUILD_IDENTITY: '' })).toThrow(
      'Release build identity differs from version'
    )
    expect(() =>
      releaseJavascriptConfiguration(root, { ...env, HIVEWARD_RELEASE_JAVASCRIPT_BUILD_IDENTITY: 'rc' })
    ).toThrow('Invalid JavaScript build identity')
  })

  it('源码 SHA 校验保留，旧遥测配置不进入构建清单', () => {
    const { root, env } = configurationFixture()
    expect(() =>
      releaseJavascriptConfiguration(root, {
        ...env,
        HIVEWARD_RELEASE_JAVASCRIPT_SOURCE_SHA: 'b'.repeat(40)
      })
    ).toThrow('Release checkout differs from bundle source')
    const result = releaseJavascriptConfiguration(root, env)
    expect(result).not.toHaveProperty('telemetryKeySha256')
    expect(result).not.toHaveProperty('diagnosticsTokenUrl')
  })
})

describe('release JavaScript transfer', () => {
  it('restores development bundles and rejects them for an official build', () => {
    const options = fixture()
    const devConfiguration = { ...configuration, identity: 'dev', telemetryKeySha256: null }
    packReleaseJavascript({ ...options, configuration: devConfiguration })
    expect(() => restoreReleaseJavascript(options)).toThrow(
      'JavaScript build configuration differs'
    )
    expect(
      restoreReleaseJavascript({ ...options, configuration: devConfiguration }).configuration
    ).toEqual(devConfiguration)
  })

  it('preserves hidden manifests, source maps and portable WASM while replacing stale outputs', () => {
    const options = fixture()
    const before = javascriptInventory(join(options.root, 'out'))
    packReleaseJavascript(options)
    writeFileSync(join(options.root, 'out', 'stale.js'), 'old')
    restoreReleaseJavascript(options)
    expect(javascriptInventory(join(options.root, 'out'))).toEqual(before)
  })

  it.each([
    'sourceSha',
    'version',
    'packageManager',
    'identity',
    'diagnosticsTokenUrl',
    'telemetryKeySha256'
  ])('rejects a different %s before replacing the current build', (field) => {
    const options = fixture()
    packReleaseJavascript(options)
    writeFileSync(join(options.root, 'out', 'main', 'index.js'), 'current build')
    writeFileSync(join(options.root, 'out', 'current-only.js'), 'current only')
    const current = javascriptInventory(join(options.root, 'out'))
    expect(() =>
      restoreReleaseJavascript({
        ...options,
        configuration: { ...configuration, [field]: 'different' }
      })
    ).toThrow('JavaScript build configuration differs')
    expect(javascriptInventory(join(options.root, 'out'))).toEqual(current)
  })

  it('rejects a damaged archive before replacing the current build', () => {
    const options = fixture()
    packReleaseJavascript(options)
    writeFileSync(join(options.artifactDir, 'release-javascript.tar.gz'), 'damaged')
    expect(() => restoreReleaseJavascript(options)).toThrow('JavaScript archive differs')
    expect(readFileSync(join(options.root, 'out', 'main', 'index.js'), 'utf8')).toBe(
      'main/index.js'
    )
  })

  it('rejects a file inventory that no longer describes the archive', () => {
    const options = fixture()
    const manifest = packReleaseJavascript(options)
    writeFileSync(join(options.root, 'out', 'main', 'index.js'), 'current build')
    writeFileSync(join(options.root, 'out', 'current-only.js'), 'current only')
    const current = javascriptInventory(join(options.root, 'out'))
    manifest.files[0].sha256 = 'c'.repeat(64)
    writeFileSync(join(options.artifactDir, 'manifest.json'), JSON.stringify(manifest))
    expect(() => restoreReleaseJavascript(options)).toThrow('JavaScript file inventory differs')
    expect(javascriptInventory(join(options.root, 'out'))).toEqual(current)
  })

  it.each([
    'addon.node',
    'launcher.exe',
    'library.dll',
    'library.dylib',
    'library.so.1',
    'relay/relay.js'
  ])('keeps %s out of the portable artifact', (file) => {
    const options = fixture()
    const destination = join(options.root, 'out', file)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, 'host output')
    expect(() => packReleaseJavascript(options)).toThrow(/native binary|host output/)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects symlinks instead of following files outside the build',
    () => {
      const options = fixture()
      const outside = join(options.root, 'outside.js')
      writeFileSync(outside, 'outside the build')
      symlinkSync(outside, join(options.root, 'out', 'linked.js'))
      expect(() => packReleaseJavascript(options)).toThrow('contains a symlink')
    }
  )

  it('refuses incomplete build output', () => {
    const options = fixture()
    rmSync(join(options.root, 'out', 'preload', 'index.js'))
    expect(() => packReleaseJavascript(options)).toThrow(
      'Missing JavaScript output: preload/index.js'
    )
  })

  it('classifies stable and suffixed RC versions and rejects other tag families', () => {
    expect(releaseBuildIdentity('v1.2.3')).toBe('stable')
    expect(releaseBuildIdentity('v1.2.3-rc.4.perf')).toBe('rc')
    expect(() => releaseBuildIdentity('mobile-v1.2.3')).toThrow('Invalid desktop release tag')
  })
})
