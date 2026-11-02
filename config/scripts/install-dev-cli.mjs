#!/usr/bin/env node
// Keep development launchers inside this checkout; never register a global command.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '../..')
const target = path.join(root, 'out/bin/opc-engine')
mkdirSync(path.dirname(target), { recursive: true })
writeFileSync(
  target,
  `#!/bin/sh\nexec node '${path.join(root, 'config/scripts/orca-dev.mjs')}' "$@"\n`,
  { mode: 0o755 }
)
console.log(`[opc-engine] Local CLI: ${target}`)
