/** Legacy SSH omits source.kind to preserve signed bytes/digests. Other kinds must set kind and omit sshTargetId:
 * older destinations strip unknown fields, then fail parsing instead of importing a non-SSH source as SSH. */
import type {
  HivewarddMigrationLocalWslManifestSource,
  HivewarddMigrationManifestSource,
  HivewarddMigrationSshManifestSource
} from './hivewardd-migration-manifest'
import { HIVEWARDD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY } from '../hivewardd-runtime-capabilities'

export const HIVEWARDD_MIGRATION_SSH_RELAY_SOURCE_KIND = 'ssh-relay' as const

/** Non-SSH kinds and the destination capability that proves a destination parses each one. */
export const HIVEWARDD_MIGRATION_SOURCE_KIND_CAPABILITIES = {
  'local-wsl': HIVEWARDD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
} as const

export type HivewarddMigrationNonSshSourceKind = keyof typeof HIVEWARDD_MIGRATION_SOURCE_KIND_CAPABILITIES
export type HivewarddMigrationSourceKind =
  | typeof HIVEWARDD_MIGRATION_SSH_RELAY_SOURCE_KIND
  | HivewarddMigrationNonSshSourceKind

export const HIVEWARDD_MIGRATION_SOURCE_KIND_UNKNOWN = 'hivewardd_migration_source_kind_unknown'

/** A manifest source as it travels: this build may not know every field a newer peer signed. */
export type HivewarddMigrationWireSource = Readonly<Record<string, unknown>>

export function hivewarddMigrationManifestSourceKind(
  source: HivewarddMigrationWireSource
): HivewarddMigrationSourceKind {
  if (source.kind === undefined) {
    return HIVEWARDD_MIGRATION_SSH_RELAY_SOURCE_KIND
  }
  // An explicit 'ssh-relay' is refused too: SSH has exactly one encoding, so one digest.
  if (isNonSshSourceKind(source.kind)) {
    return source.kind
  }
  throw new Error(HIVEWARDD_MIGRATION_SOURCE_KIND_UNKNOWN)
}

function isNonSshSourceKind(kind: unknown): kind is HivewarddMigrationNonSshSourceKind {
  return typeof kind === 'string' && Object.hasOwn(HIVEWARDD_MIGRATION_SOURCE_KIND_CAPABILITIES, kind)
}

/** The capability a destination must advertise before it may see this source; null for SSH. */
export function requiredHivewarddMigrationSourceCapability(
  source: HivewarddMigrationWireSource
): string | null {
  const kind = hivewarddMigrationManifestSourceKind(source)
  return kind === HIVEWARDD_MIGRATION_SSH_RELAY_SOURCE_KIND
    ? null
    : HIVEWARDD_MIGRATION_SOURCE_KIND_CAPABILITIES[kind]
}

export function isHivewarddMigrationLocalWslSource(
  source: HivewarddMigrationManifestSource
): source is HivewarddMigrationLocalWslManifestSource {
  return 'kind' in source && source.kind === 'local-wsl'
}

/** For the SSH conversion's own steps: a WSL manifest reaching them is a bug, never a fallback. */
export function requireHivewarddMigrationSshSource(
  source: HivewarddMigrationManifestSource
): HivewarddMigrationSshManifestSource {
  if (isHivewarddMigrationLocalWslSource(source)) {
    throw new Error('hivewardd_migration_source_not_ssh')
  }
  return source
}
