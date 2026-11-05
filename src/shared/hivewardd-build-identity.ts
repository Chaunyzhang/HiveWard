import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { HIVEWARDD_LAUNCHER_FILENAME, HIVEWARDD_SERVER_ENTRY_FILENAME } from './hivewardd-artifacts'

export const HIVEWARDD_BUILD_HASH_LENGTH = 16

/** The launcher embeds its server digest, keeping the hash older clients calculate. */
export function hashHivewarddLauncher(entryPath: string): string {
  const entry = realpathSync(entryPath)
  const launcher =
    basename(entry) === HIVEWARDD_SERVER_ENTRY_FILENAME
      ? join(dirname(entry), HIVEWARDD_LAUNCHER_FILENAME)
      : entry
  return createHash('sha256')
    .update(readFileSync(launcher))
    .digest('hex')
    .slice(0, HIVEWARDD_BUILD_HASH_LENGTH)
}
