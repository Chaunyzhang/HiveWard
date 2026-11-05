// Regenerates the host-method region of resources/plugins/declarative/hiveward.d.ts from the host API
// table. `--check` fails when it is stale instead of rewriting it.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadPluginSchemaModule, REPO_ROOT } from './plugin-schema-module-loader.mjs'

const TYPINGS = path.join(REPO_ROOT, 'resources', 'plugins', 'declarative', 'hiveward.d.ts')
const { spliceHiveWardHostTypings } = loadPluginSchemaModule(
  'declarative/plugin-declarative-host-typings.ts'
)
const current = readFileSync(TYPINGS, 'utf8')
const next = spliceHiveWardHostTypings(current)
if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('hiveward.d.ts host methods are stale; run pnpm generate:plugin-declarative-typings')
    process.exit(1)
  }
} else if (next !== current) {
  writeFileSync(TYPINGS, next)
  console.log(`wrote ${path.relative(REPO_ROOT, TYPINGS)}`)
}
