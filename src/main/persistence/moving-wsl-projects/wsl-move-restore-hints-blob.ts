import { createHash } from 'node:crypto'
import type { HivewarddMigrationBlobDescriptor } from '../../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import { sameHivewarddMigrationBlob } from '../../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import {
  MAX_HIVEWARDD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES,
  HIVEWARDD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY,
  HIVEWARDD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION,
  parseHivewarddMigrationTerminalRestoreHintsDocument,
  type HivewarddMigrationTerminalRestoreHint
} from '../../../shared/hivewardd-migration/hivewardd-migration-terminal-restore-hints'
import type { HivewarddMigrationBlobSource } from '../../ssh/hivewardd-migration-blob-coordinator'

export type WslMoveRestoreHintsBlob = {
  descriptor: HivewarddMigrationBlobDescriptor
  bytes: Buffer
  source: HivewarddMigrationBlobSource
}

/** Omit the blob when there are no hints. */
export function buildWslMoveRestoreHintsBlob(
  hints: readonly HivewarddMigrationTerminalRestoreHint[]
): WslMoveRestoreHintsBlob | null {
  if (hints.length === 0) {
    return null
  }
  // Validate before staging so malformed hints fail while the source still owns the move.
  const document = parseHivewarddMigrationTerminalRestoreHintsDocument({
    version: HIVEWARDD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION,
    hints: hints.map((hint) => ({ paneKey: hint.paneKey, cwd: hint.cwd }))
  })
  const bytes = Buffer.from(JSON.stringify(document), 'utf8')
  if (bytes.length > MAX_HIVEWARDD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES) {
    throw new Error('hivewardd_migration_terminal_restore_hints_too_large')
  }
  const descriptor: HivewarddMigrationBlobDescriptor = {
    blobKind: 'terminal-restore-hints',
    key: HIVEWARDD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length
  }
  return {
    descriptor,
    bytes,
    source: {
      readChunk: async (requested, offset, maxBytes) => {
        if (!sameHivewarddMigrationBlob(requested, descriptor)) {
          throw new Error(`hivewardd_migration_source_blob_changed:${requested.blobKind}`)
        }
        return bytes.subarray(offset, offset + maxBytes)
      }
    }
  }
}
