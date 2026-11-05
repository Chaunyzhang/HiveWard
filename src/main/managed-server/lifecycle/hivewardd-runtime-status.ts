import type { HivewarddManagedRuntimeStatus } from '../../../shared/hivewardd-managed-runtime'
import { runTargetLifecycle } from '../../ipc/ssh/ssh-target-lifecycle-queue'
import type { HivewarddActivationTransaction } from '../activation/hivewardd-activation-transaction'
import { readHivewarddActivationTransaction } from '../activation/hivewardd-activation-transaction-store'
import {
  requireManagedHivewarddEnvironment,
  resolveLinkedHivewarddContext
} from './hivewardd-managed-runtime-context'
import { currentManagedHivewarddUpdateDeferral } from './hivewardd-managed-update-deferrals'
import { findIncompleteManagedHivewarddMigration } from './hivewardd-managed-migration-status'
import { collectManagedTerminalCensus } from '../../ssh/hivewardd-terminal-census-client'
import { getAppEnvironment } from '../../../shared/app-environment'
import { bundledManagedHivewarddVersion } from './hivewardd-managed-auto-update'
import { availableManagedHivewarddUpdate } from './hivewardd-managed-update-decision'

/** Read host records without repairing them. */
export async function getManagedHivewarddRuntimeStatus(
  userDataPath: string,
  selector: string,
  signal?: AbortSignal
): Promise<HivewarddManagedRuntimeStatus> {
  const { environment, deployment } = requireManagedHivewarddEnvironment(userDataPath, selector)
  const { status, record, serverTarget } = await runTargetLifecycle(
    deployment.sshTargetId,
    async () => {
      const context = await resolveLinkedHivewarddContext(environment, deployment, signal)
      const record = context.activationRecord
      const transaction = await readHivewarddActivationTransaction({
        conn: context.connection,
        host: context.host,
        remoteHome: context.remoteHome,
        signal
      })
      const status: HivewarddManagedRuntimeStatus = {
        environmentId: environment.id,
        sshTargetId: context.target.id,
        activeVersion: record.active,
        activeAppVersion: record.active ? (record.activeAppVersion ?? null) : null,
        previousVersion: record.previous,
        activatedAt: record.activatedAt,
        rollbackAvailable: Boolean(record.previous && record.snapshot),
        recovery: transaction ? managedRecoveryStatus(transaction) : null,
        terminals: await collectManagedTerminalCensus(userDataPath, environment, record),
        migration: migrationStatus(userDataPath, environment.id),
        deferredUpdate: currentManagedHivewarddUpdateDeferral(environment.id, record.active)
      }
      return { status, record, serverTarget: context.serverTarget }
    }
  )
  // Outside the host queue: hashing the local template must not hold up host actions.
  // A local template fault hides only the offer, never the host's status.
  const candidateVersion = await bundledManagedHivewarddVersion(serverTarget).catch(() => null)
  return {
    ...status,
    availableUpdate: availableManagedHivewarddUpdate({
      record,
      candidateVersion,
      appVersion: getAppEnvironment().getVersion(),
      deferredCandidateVersion: status.deferredUpdate?.candidateVersion ?? null
    })
  }
}

function managedRecoveryStatus(
  transaction: HivewarddActivationTransaction
): NonNullable<HivewarddManagedRuntimeStatus['recovery']> {
  switch (transaction.operation) {
    case 'activate':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.candidateVersion,
        startedAt: transaction.startedAt
      }
    case 'rollback':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.targetVersion,
        startedAt: transaction.startedAt
      }
    case 'decommission':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.activeVersion,
        startedAt: transaction.startedAt
      }
  }
}

function migrationStatus(
  userDataPath: string,
  environmentId: string
): HivewarddManagedRuntimeStatus['migration'] {
  const migration = findIncompleteManagedHivewarddMigration(userDataPath, environmentId)
  return migration
    ? { migrationId: migration.migrationId, phase: migration.phase, startedAt: migration.startedAt }
    : null
}
