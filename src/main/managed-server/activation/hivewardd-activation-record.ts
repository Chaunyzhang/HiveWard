// Keep activation identity, rollback target and state snapshot outside version directories so GC cannot erase recovery metadata.
import { remoteInstallDirName, HIVEWARDD_INSTALL_MODEL } from '../install/remote-install-model'

export const HIVEWARDD_ACTIVATION_FILENAME = 'hivewardd-active.json'
export const HIVEWARDD_ACTIVATION_SCHEMA_VERSION = 1

export const HIVEWARDD_STATE_SNAPSHOT_DIR = 'hivewardd-state-snapshots'

export type HivewarddStateSnapshot = {
  dirName: string
  /** Activation this snapshot precedes. */
  takenBeforeVersion: string
  /** Build that produced this state and can read it during rollback. */
  readableByVersion: string | null
  takenAt: string
}

export type HivewarddActivationRecord = {
  schemaVersion: typeof HIVEWARDD_ACTIVATION_SCHEMA_VERSION
  /** Content-hashed install version; null before activation or after decommission. */
  active: string | null
  /** Rollback target, pinned against GC. */
  previous: string | null
  activatedAt: string | null
  snapshot: HivewarddStateSnapshot | null
  /** Optional app provenance; older builds omit it, so mixed-version readers must tolerate absence. */
  /** 版本来源；与应用协议和存储 schema 独立。 */
  activeProduct?: string
  previousProduct?: string
  /** 区分继承的版号与 HiveWard 正式版本线，避免把数字相同的未来版本当成迁移。 */
  activeVersionFamily?: 'inherited' | 'hiveward'
  previousVersionFamily?: 'inherited' | 'hiveward'
  activeAppVersion?: string
  previousAppVersion?: string
  /** Explicit rollback suppresses reconnect auto-reactivation of this build. */
  rolledBackFrom?: string
}

export function emptyHivewarddActivationRecord(): HivewarddActivationRecord {
  return {
    schemaVersion: HIVEWARDD_ACTIVATION_SCHEMA_VERSION,
    active: null,
    previous: null,
    activatedAt: null,
    snapshot: null
  }
}

/** Distinguish absent from unreadable so older clients cannot deploy over records they cannot interpret. */
export type HivewarddActivationReadResult =
  | { state: 'absent' }
  | { state: 'ok'; record: HivewarddActivationRecord }
  | { state: 'unreadable'; reason: string }

export function parseHivewarddActivationRecord(raw: string | null): HivewarddActivationReadResult {
  if (raw === null || raw.trim() === '') {
    return { state: 'absent' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      state: 'unreadable',
      reason: `activation record is not JSON: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { state: 'unreadable', reason: 'activation record is not an object' }
  }
  const record = parsed as Partial<HivewarddActivationRecord>
  if (record.schemaVersion !== HIVEWARDD_ACTIVATION_SCHEMA_VERSION) {
    return {
      state: 'unreadable',
      reason:
        `activation record schemaVersion ${String(record.schemaVersion)} is not ` +
        `${HIVEWARDD_ACTIVATION_SCHEMA_VERSION}; this client cannot safely interpret it`
    }
  }
  return {
    state: 'ok',
    record: {
      schemaVersion: HIVEWARDD_ACTIVATION_SCHEMA_VERSION,
      active: typeof record.active === 'string' ? record.active : null,
      previous: typeof record.previous === 'string' ? record.previous : null,
      activatedAt: typeof record.activatedAt === 'string' ? record.activatedAt : null,
      snapshot: parseSnapshot(record.snapshot),
      ...(['inherited', 'hiveward'].includes(record.activeVersionFamily ?? '')
        ? { activeVersionFamily: record.activeVersionFamily }
        : {}),
      ...(['inherited', 'hiveward'].includes(record.previousVersionFamily ?? '')
        ? { previousVersionFamily: record.previousVersionFamily }
        : {}),
      ...(typeof record.activeProduct === 'string' ? { activeProduct: record.activeProduct } : {}),
      ...(typeof record.previousProduct === 'string'
        ? { previousProduct: record.previousProduct }
        : {}),
      ...(typeof record.activeAppVersion === 'string'
        ? { activeAppVersion: record.activeAppVersion }
        : {}),
      ...(typeof record.previousAppVersion === 'string'
        ? { previousAppVersion: record.previousAppVersion }
        : {}),
      ...(typeof record.rolledBackFrom === 'string'
        ? { rolledBackFrom: record.rolledBackFrom }
        : {})
    }
  }
}

function parseSnapshot(value: unknown): HivewarddStateSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const snapshot = value as Partial<HivewarddStateSnapshot>
  if (typeof snapshot.dirName !== 'string' || typeof snapshot.takenBeforeVersion !== 'string') {
    return null
  }
  return {
    dirName: snapshot.dirName,
    takenBeforeVersion: snapshot.takenBeforeVersion,
    readableByVersion:
      typeof snapshot.readableByVersion === 'string' ? snapshot.readableByVersion : null,
    takenAt: typeof snapshot.takenAt === 'string' ? snapshot.takenAt : ''
  }
}

/** Omit advisory fields dropped by older peers so their journals still match the committed core record. */
export function coreHivewarddActivationRecord(record: HivewarddActivationRecord): HivewarddActivationRecord {
  const {
    activeVersionFamily: _family,
    previousVersionFamily: _previousFamily,
    activeProduct: _product,
    previousProduct: _previousProduct,
    activeAppVersion: _app,
    previousAppVersion: _prev,
    rolledBackFrom: _held,
    ...core
  } = record
  return core
}

export function serializeHivewarddActivationRecord(record: HivewarddActivationRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

export function withActivatedVersion(
  record: HivewarddActivationRecord,
  version: string,
  snapshot: HivewarddStateSnapshot | null,
  now: Date,
  appVersion?: string
): HivewarddActivationRecord {
  const same = record.active === version
  // A decommissioned record can retain app provenance without naming an active predecessor.
  const previousAppVersion = same
    ? record.previousAppVersion
    : record.active
      ? record.activeAppVersion
      : undefined
  const previousVersionFamily = same
    ? record.previousVersionFamily
    : record.active
      ? record.activeVersionFamily
      : undefined
  const previousProduct = same
    ? record.previousProduct
    : record.active
      ? record.activeProduct
      : undefined
  return {
    schemaVersion: HIVEWARDD_ACTIVATION_SCHEMA_VERSION,
    active: version,
    // Re-activating identical bytes must preserve the existing rollback target.
    previous: same ? record.previous : record.active,
    activatedAt: now.toISOString(),
    snapshot: same ? record.snapshot : snapshot,
    activeProduct: 'HiveWard',
    activeVersionFamily: 'hiveward',
    ...(appVersion ? { activeAppVersion: appVersion } : {}),
    ...(previousAppVersion ? { previousAppVersion } : {}),
    ...(previousProduct ? { previousProduct } : {}),
    ...(previousVersionFamily ? { previousVersionFamily } : {})
  }
}

export function withRolledBackVersion(
  record: HivewarddActivationRecord,
  now: Date
): HivewarddActivationRecord {
  return {
    schemaVersion: HIVEWARDD_ACTIVATION_SCHEMA_VERSION,
    active: record.previous,
    // Rolling back must not offer the failed build as the next rollback target.
    previous: null,
    activatedAt: now.toISOString(),
    // Restoring consumes the snapshot taken before the outgoing build ran.
    snapshot: null,
    ...(record.previousAppVersion ? { activeAppVersion: record.previousAppVersion } : {}),
    ...(record.previousProduct ? { activeProduct: record.previousProduct } : {}),
    ...(record.previousVersionFamily ? { activeVersionFamily: record.previousVersionFamily } : {}),
    ...(record.active ? { rolledBackFrom: record.active } : {})
  }
}

export function withDeactivatedVersion(record: HivewarddActivationRecord): HivewarddActivationRecord {
  return {
    schemaVersion: HIVEWARDD_ACTIVATION_SCHEMA_VERSION,
    active: null,
    // Pin the stopped build for redeploy and any daemon still using its entry.
    previous: record.active,
    activatedAt: null,
    snapshot: null
  }
}

/** Commit-only provenance; never journal it because released peers compare core-only stop records byte for byte. */
export function withDeactivatedVersionCommitted(
  record: HivewarddActivationRecord
): HivewarddActivationRecord {
  return {
    ...withDeactivatedVersion(record),
    // Newer state may survive decommission; preserve provenance so older planners still refuse it.
    ...(record.activeAppVersion ? { activeAppVersion: record.activeAppVersion } : {}),
    ...(record.activeProduct ? { activeProduct: record.activeProduct } : {}),
    ...(record.activeVersionFamily ? { activeVersionFamily: record.activeVersionFamily } : {}),
    ...(record.rolledBackFrom ? { rolledBackFrom: record.rolledBackFrom } : {})
  }
}

/** Pin rollback bytes and any outgoing bundle still serving a live daemon. */
export function hivewarddGcPinnedDirNames(
  record: HivewarddActivationRecord,
  daemonEntryVersion?: string | null
): string[] {
  return hivewarddInstallDirNames([record.active, record.previous, daemonEntryVersion])
}

export function hivewarddInstallDirNames(versions: readonly (string | null | undefined)[]): string[] {
  const named = versions.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return [...new Set(named)].map((version) => remoteInstallDirName(HIVEWARDD_INSTALL_MODEL, version))
}
