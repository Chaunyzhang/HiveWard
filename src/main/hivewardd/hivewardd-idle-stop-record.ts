// Consume clean idle-stop evidence once; discard failed stops so later crashes cannot inherit it.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  HIVEWARDD_IDLE_STOP_RECORD_FILENAME,
  HivewarddIdleStopRecordSchema,
  type HivewarddIdleStopRecord
} from '../../shared/hivewardd-idle-exit'
import type { HivewarddIdleExitEvidence } from './hivewardd-idle-exit-monitor'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

const RECORD_MAX_BYTES = 16 * 1024

export function hivewarddIdleStopRecordPath(userDataPath: string): string {
  return join(userDataPath, HIVEWARDD_IDLE_STOP_RECORD_FILENAME)
}

export function writeHivewarddIdleStopRecord(
  userDataPath: string,
  evidence: HivewarddIdleExitEvidence,
  version: string
): void {
  const record: HivewarddIdleStopRecord = {
    schemaVersion: 1,
    kind: 'hivewardd_idle_stop',
    pid: process.pid,
    version,
    quietSince: new Date(evidence.quietSince).toISOString(),
    stoppedAt: new Date(evidence.stoppedAt).toISOString(),
    idleTimeoutMs: evidence.timeoutMs
  }
  if (!writeDurableSecureJsonFile(hivewarddIdleStopRecordPath(userDataPath), record)) {
    throw new Error('hivewardd_idle_stop_record_permissions_unconfirmed')
  }
}

export function consumeHivewarddIdleStopRecord(userDataPath: string): HivewarddIdleStopRecord | null {
  const path = hivewarddIdleStopRecordPath(userDataPath)
  let record: HivewarddIdleStopRecord | null = null
  try {
    const raw = readNodeFileSyncWithinLimit(path, RECORD_MAX_BYTES).buffer.toString('utf8')
    record = HivewarddIdleStopRecordSchema.parse(JSON.parse(raw))
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null
    }
    console.error('[hivewardd] ignoring an unreadable idle-stop record:', error)
  }
  rmSync(path, { force: true })
  return record
}

export function discardHivewarddIdleStopRecord(userDataPath: string): void {
  rmSync(hivewarddIdleStopRecordPath(userDataPath), { force: true })
}
