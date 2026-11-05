import { build } from 'esbuild'
import { join } from 'node:path'
import { HIVEWARDD_LINEAR_SDK_ENTRY } from '../../src/shared/hivewardd-artifacts.ts'
import { HIVEWARDD_SERVER_BUILD_TARGET } from './hivewardd-entry-build.mjs'

// Bundle @linear/sdk into one CJS file for lazy require: copying would expose chunk names that change each release.
export async function stageHivewarddLinearSdk(root, outputDir) {
  await build({
    stdin: {
      contents: "module.exports = require('@linear/sdk')",
      resolveDir: root,
      sourcefile: 'hivewardd-linear-sdk-entry.js'
    },
    bundle: true,
    platform: 'node',
    target: HIVEWARDD_SERVER_BUILD_TARGET,
    format: 'cjs',
    outfile: join(outputDir, HIVEWARDD_LINEAR_SDK_ENTRY),
    minify: true,
    sourcemap: false,
    logLevel: 'error'
  })
}
