import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { copyFiles, FileMatcher } = require('app-builder-lib/out/fileMatcher')

describe('packaged repository input exclusion', () => {
  it('omits repository build inputs while preserving runtime files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hiveward-packaging-inputs-'))
    const source = join(root, 'app')
    const destination = join(root, 'selected')
    const cloudPaths = [
      'cloud/apps/relay/src/index.ts',
      'cloud/apps/push/src/app.test.ts',
      'cloud/infra/main.tf',
      'cloud/dev/scripts/deploy.mjs',
      'cloud/.env',
      'cloud/packages/push-contract/src/push-host-proof-vector.json'
    ]
    const rootConfigs = [
      '.oxlintrc.json',
      '.oxfmtrc.json',
      'components.json',
      'opencode.json',
      'hiveward.yaml',
      'pnpm-workspace.yaml',
      'vite.web.config.ts'
    ]
    const runtimePaths = [
      'LICENSE',
      'package.json',
      'out/main/index.js',
      'out/cli/index.js',
      'resources/configs/hiveward.yaml',
      'resources/cloud/icon.png'
    ]
    const excludedPaths = [
      'out/renderer/index.html',
      'out/renderer/assets/client.js',
      'out/mobile-web/manifest.json'
    ]
    try {
      for (const fixturePath of [
        ...cloudPaths,
        ...rootConfigs,
        ...runtimePaths,
        ...excludedPaths
      ]) {
        const file = join(source, fixturePath)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, fixturePath)
      }
      await copyFiles([
        new FileMatcher(source, destination, (value) => value, electronBuilderConfig.files)
      ])
      expect(existsSync(join(destination, 'cloud'))).toBe(false)
      expect(excludedPaths.filter((file) => existsSync(join(destination, file)))).toEqual([])
      expect(rootConfigs.filter((file) => existsSync(join(destination, file)))).toEqual([])
      for (const runtimePath of runtimePaths) {
        expect(await readFile(join(destination, runtimePath), 'utf8')).toBe(runtimePath)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
