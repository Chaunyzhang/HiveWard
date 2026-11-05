import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { HIVEWARDD_SERVER_ENTRY_FILENAME } from '../../shared/hivewardd-artifacts'
import { assertHivewarddServerRuntime, handoffToBundledHivewardd } from './hivewardd-bundled-runtime'
import { HIVEWARDD_EXIT_CONFIGURATION } from './hivewardd-configuration-exit'
import { enableManagedHivewarddCompileCache } from './hivewardd-compile-cache'

declare const HIVEWARDD_SERVER_SHA256: string

let loadServer: (() => void) | undefined

try {
  if (!handoffToBundledHivewardd()) {
    assertHivewarddServerRuntime()
    const entry = realpathSync(process.argv[1] ?? __filename)
    const server = join(dirname(entry), HIVEWARDD_SERVER_ENTRY_FILENAME)
    if (createHash('sha256').update(readFileSync(server)).digest('hex') !== HIVEWARDD_SERVER_SHA256) {
      throw new Error('The HiveWard server does not match its launcher')
    }
    loadServer = () => {
      enableManagedHivewarddCompileCache(dirname(entry))
      createRequire(entry)(server)
    }
  }
} catch (error) {
  console.error('hivewardd: failed to launch:', error)
  process.exit(HIVEWARDD_EXIT_CONFIGURATION)
}

loadServer?.()
