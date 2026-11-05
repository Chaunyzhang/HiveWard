/** Persist journals in owner-only profile sidecars: older profile schemas drop unknown fields but retain fences, so an in-profile journal could vanish on downgrade. Unreadable journals fail closed. */
import {
  MAX_HIVEWARDD_MIGRATION_SOURCE_CUTOVERS,
  isRetainedHivewarddMigrationSourceCutover,
  parseHivewarddMigrationSourceCutover,
  type HivewarddMigrationSourceCutover
} from '../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import {
  createMigrationJournalDirectory,
  orderMigrationJournalChain
} from '../persistence/migrating-hivewardd-catalog/migration-journal-directory'

class HivewarddMigrationCutoverJournalUnreadableError extends Error {
  constructor(detail: string) {
    super(`The migration journal cannot be read, so the SSH host stays fenced: ${detail}`)
    this.name = 'HivewarddMigrationCutoverJournalUnreadableError'
  }
}

type JournalChangeListener = (userDataPath: string) => void
let journalChangeListener: JournalChangeListener | null = null

export function setHivewarddMigrationJournalChangeListener(
  listener: JournalChangeListener | null
): void {
  journalChangeListener = listener
}

const journals = createMigrationJournalDirectory({
  directoryName: 'hivewardd-migration-cutovers',
  // A manifest carries catalog rows and dormant session state, never scrollback bytes.
  maxFileBytes: 16 * 1024 * 1024,
  parse: parseHivewarddMigrationSourceCutover,
  unreadable: (detail) => new HivewarddMigrationCutoverJournalUnreadableError(detail),
  onChange: (userDataPath) => journalChangeListener?.(userDataPath)
})

export function hivewarddMigrationCutoverJournalDirectory(userDataPath: string): string {
  return journals.directory(userDataPath)
}

/** Never skip an unreadable or untrusted journal. */
export function listHivewarddMigrationSourceCutovers(
  userDataPath: string
): HivewarddMigrationSourceCutover[] {
  return journals.list(userDataPath)
}

export function findHivewarddMigrationSourceCutoverForTarget(
  userDataPath: string,
  sshTargetId: string
): HivewarddMigrationSourceCutover | null {
  const chain = listHivewarddMigrationCutoverChainForTarget(userDataPath, sshTargetId)
  return chain.at(-1) ?? null
}

/** Oldest first; throws unless the target's journals form one chain of delta moves. */
export function listHivewarddMigrationCutoverChainForTarget(
  userDataPath: string,
  sshTargetId: string
): HivewarddMigrationSourceCutover[] {
  const matches = listHivewarddMigrationSourceCutovers(userDataPath).filter(
    (cutover) => cutover.sshTargetId === sshTargetId
  )
  return orderMigrationJournalChain(
    matches,
    (detail) => new HivewarddMigrationCutoverJournalUnreadableError(detail),
    `SSH target ${sshTargetId}`
  )
}

/** Flush before returning so later fence writes always have a durable journal. */
export function writeHivewarddMigrationSourceCutover(
  userDataPath: string,
  cutover: HivewarddMigrationSourceCutover
): void {
  const parsed = parseHivewarddMigrationSourceCutover(cutover)
  const existing = listHivewarddMigrationSourceCutovers(userDataPath)
  // Finished retained cutovers can wait two releases; only in-flight journals count toward the bound.
  const inFlight = existing.filter(
    (entry) => entry.phase !== 'source-retired' && !isRetainedHivewarddMigrationSourceCutover(entry)
  )
  if (
    !existing.some((entry) => entry.migrationId === parsed.migrationId) &&
    inFlight.length >= MAX_HIVEWARDD_MIGRATION_SOURCE_CUTOVERS
  ) {
    throw new Error('hivewardd_migration_cutover_capacity_exceeded')
  }
  journals.write(userDataPath, parsed)
}

export function removeHivewarddMigrationSourceCutover(userDataPath: string, migrationId: string): void {
  journals.remove(userDataPath, migrationId)
}

export function removeHivewarddMigrationJournalsForDestination(
  userDataPath: string,
  sshTargetId: string,
  environmentId: string
): void {
  for (const cutover of listHivewarddMigrationSourceCutovers(userDataPath)) {
    if (cutover.sshTargetId === sshTargetId && cutover.destinationEnvironmentId === environmentId) {
      removeHivewarddMigrationSourceCutover(userDataPath, cutover.migrationId)
    }
  }
}
