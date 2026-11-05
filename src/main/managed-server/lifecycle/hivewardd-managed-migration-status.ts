import {
  isRetainedHivewarddMigrationSourceCutover,
  type HivewarddMigrationSourceCutover
} from '../../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import {
  getHivewarddSshDeployment,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { listHivewarddMigrationSourceCutovers } from '../../ssh/hivewardd-migration-cutover-journal'

type HivewarddManagedPendingMigration = {
  migrationId: string
  environmentId: string
  name: string
  sshTargetId: string
  phase: HivewarddMigrationSourceCutover['phase']
  startedAt: string
}

/** Unreadable journals must not look like absent migrations. */
export function listPendingManagedHivewarddMigrations(
  userDataPath: string
): HivewarddManagedPendingMigration[] {
  return (
    listHivewarddMigrationSourceCutovers(userDataPath)
      // Committed/retained journals preserve downgrade recovery, not pending migration work.
      .filter(
        (cutover) =>
          cutover.phase !== 'source-retired' && !isRetainedHivewarddMigrationSourceCutover(cutover)
      )
      .map((cutover) => ({
        migrationId: cutover.migrationId,
        environmentId: cutover.destinationEnvironmentId,
        name: cutover.destinationName,
        sshTargetId: cutover.sshTargetId,
        phase: cutover.phase,
        startedAt: cutover.startedAt
      }))
  )
}

export function findIncompleteManagedHivewarddMigration(
  userDataPath: string,
  environmentId: string
): HivewarddManagedPendingMigration | null {
  return (
    listPendingManagedHivewarddMigrations(userDataPath).find(
      (migration) => migration.environmentId === environmentId
    ) ?? null
  )
}

export function environmentMatchesManagedHivewarddCutover(
  environment: KnownRuntimeEnvironment,
  cutover: HivewarddMigrationSourceCutover
): boolean {
  const deployment = getHivewarddSshDeployment(environment)
  return (
    environment.id === cutover.destinationEnvironmentId &&
    environment.name === cutover.destinationName &&
    deployment?.sshTargetId === cutover.sshTargetId &&
    deployment.sshTargetGeneration === cutover.sshTargetGeneration
  )
}
