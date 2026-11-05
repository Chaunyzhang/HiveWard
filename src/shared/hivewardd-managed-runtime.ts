import type { PublicKnownRuntimeEnvironment } from './runtime-environments'
import type { HivewarddTerminalCensus } from './hivewardd-terminal-census'
import type { HivewarddMigrationBlocker } from './hivewardd-migration/hivewardd-migration-preflight'
import type { HivewarddMigrationSourceCutoverPhase } from './hivewardd-migration/hivewardd-migration-source-cutover'
import type { HivewarddDaemonRetirementVerdict } from './hivewardd-stop-request'
import type { SshManagedServerLinkedProject } from './ssh-types'
import type { HivewarddStaleLockEvidence } from './hivewardd-stale-lock-reclaim'

export const HIVEWARDD_MANAGED_REMOTE_PORT = 6_768

/** Refused because terminals are, or may be, still running on the host. */
export type HivewarddManagedRefusal = {
  outcome: 'refused'
  verdict: 'live' | 'unverifiable'
  code: string
  reason: string
  /** Only saved state blocks, which a confirmed "Move anyway" leaves on this desktop. */
  canLeaveBehind?: true
}

export type HivewarddManagedDeferral = {
  outcome: 'deferred'
  candidateVersion: string
  code: string
  reason: string
  /** False when force cannot make the rejected lifecycle transition safe. */
  forceable?: boolean
}

/** The one deferral Update anyway may pass: counted terminals the daemon carries across. */
export const HIVEWARDD_UPDATE_TERMINALS_RUNNING_CODE = 'hivewardd_update_terminals_running'

/** Update anyway passes counted live-terminal deferrals, preserves version admission, and requires the confirmed incumbent build. */
export type HivewarddManagedPastLiveTerminals = { incumbentVersion: string | null }

export type HivewarddManagedDeployResult =
  | {
      outcome: 'created' | 'updated' | 'already-current'
      environment: PublicKnownRuntimeEnvironment
      activeVersion: string
    }
  | HivewarddManagedDeferral

export type HivewarddManagedRollbackResult =
  | {
      outcome: 'rolled-back'
      environment: PublicKnownRuntimeEnvironment
      activeVersion: string
      discarded: string[]
    }
  | { outcome: 'refused' | 'failed'; code: string; reason: string }

/** A recovery that needs the operator to accept restoring a snapshot over changed state. */
export const HIVEWARDD_RECOVERY_CHANGED_STATE_CODE = 'hivewardd_recovery_changed_state'

export type HivewarddManagedRecoveryResult =
  | { outcome: 'none' }
  | { outcome: 'pending'; code: string; reason: string }
  | {
      outcome: 'recovered'
      resolution: 'committed' | 'restored-incumbent'
      activeVersion: string | null
      environment: PublicKnownRuntimeEnvironment
    }
  | HivewarddManagedRefusal

/** Only a proven `exited` unlinks the server locally; anything less keeps it linked. */
export type HivewarddManagedStopResult =
  | {
      outcome: 'unlinked'
      verdict: 'exited'
      environmentId: string
      sshTargetId: string
      stoppedVersion: string | null
      retirement: HivewarddDaemonRetirementVerdict | null
    }
  | HivewarddManagedRefusal

/** Refuse restart with live or unverifiable terminals: the daemon outlives hivewardd and retains its inherited environment. */
export type HivewarddManagedRestartResult =
  | { outcome: 'restarted'; environmentId: string }
  | { outcome: 'terminals-running'; liveSessions: number | null }
  | { outcome: 'not-restarted'; reason: string }

/** A dry run, or a confirmation pinned to the lock record that dry run showed. */
export type HivewarddManagedStaleLockReclaimRequest =
  | { yes: false }
  | { yes: true; expectNonce: string }

/** `hivewardd --reclaim-stale-lock` run on a managed host's active slot (#32177). */
export type HivewarddManagedStaleLockReclaimResult =
  | {
      status: 'none' | 'eligible' | 'refused'
      message: string
      lockPath: string
      evidence?: HivewarddStaleLockEvidence
    }
  /** `notRestarted` says why the server did not start again once its lock was cleared. */
  | {
      status: 'reclaimed'
      environmentId: string
      message: string
      lockPath: string
      /** The record the reclaim acted on. */
      evidence?: HivewarddStaleLockEvidence
      notRestarted?: string
    }
  /** No remote reclaim occurred. reclaimWithoutPin requires manual reclaim because the host cannot pin confirmation;
   * otherwise lockPath names the lock to delete manually. */
  | { status: 'unsupported'; message: string; lockPath?: string; reclaimWithoutPin?: true }
  /** The slot runs the command but gave no answer this client understands; nothing is known. */
  | { status: 'no-answer'; message: string }
  /** Another lifecycle step holds the host; nothing changed. */
  | { status: 'busy'; message: string }

/** Forget only unlinks this desktop; an unreachable server may still run, so its verdict remains unverifiable. */
export type HivewarddManagedForgetResult =
  | {
      outcome: 'forgotten'
      verdict: 'unverifiable'
      environmentId: string
      sshTargetId: string
    }
  | HivewarddManagedRefusal

export type HivewarddManagedCancelStopResult =
  | { outcome: 'none' }
  /** The stop was withdrawn before hivewardd acted on it; the server keeps serving. */
  | { outcome: 'canceled'; activeVersion: string }
  /** hivewardd had already exited; finish with stop to unlink the server. */
  | { outcome: 'already-stopped' }
  | HivewarddManagedRefusal

export type HivewarddManagedRuntimeStatus = {
  environmentId: string
  sshTargetId: string
  activeVersion: string | null
  previousVersion: string | null
  activatedAt: string | null
  rollbackAvailable: boolean
  recovery:
    | {
        operation: 'activate'
        phase: 'prepared' | 'incumbent-stopped' | 'snapshot-captured' | 'candidate-ready'
        version: string
        startedAt: string
      }
    | {
        operation: 'rollback'
        phase:
          | 'prepared'
          | 'incumbent-stopped'
          | 'rescue-captured'
          | 'rollback-state-restored'
          | 'target-ready'
        version: string
        startedAt: string
      }
    | {
        operation: 'decommission'
        phase: 'prepared' | 'stop-dispatched' | 'process-exited'
        version: string
        startedAt: string
      }
    | null
  /** Terminals the daemon runs; `null` counts are unverifiable and block updates and stops. */
  terminals: HivewarddTerminalCensus
  /** An unfinished dormant migration into this server; a rollback is refused while it runs. */
  migration: {
    migrationId: string
    phase: HivewarddMigrationSourceCutoverPhase
    startedAt: string
  } | null
  /** The last update this client deferred for this server, cleared once one goes through. */
  deferredUpdate: (HivewarddManagedDeferral & { deferredAt: string }) | null
  /** The HiveWard release that activated `activeVersion`; absent when unknown or from older desktops. */
  activeAppVersion?: string | null
  /** This desktop's bundled build when Update would move the host to it; absent from older desktops. */
  availableUpdate?: string | null
}

export type HivewarddManagedConversionResult =
  | {
      /** Committed on the server and retired from the SSH host. */
      outcome: 'converted'
      environment: PublicKnownRuntimeEnvironment
      migrationId: string
      /** Projects the server already held, so this desktop's own state for them did not move. */
      linkedProjects?: SshManagedServerLinkedProject[]
      /** Moved automations the server would not re-enable; they stay off there. */
      automationsLeftDisabled?: number
    }
  | HivewarddManagedDeferral
  | HivewarddManagedRefusal

export type HivewarddManagedPendingMigrationRow = {
  migrationId: string
  environmentId: string
  name: string
  sshTargetId: string
  phase: HivewarddMigrationSourceCutoverPhase
  startedAt: string
}

export type HivewarddDeltaMoveRow = {
  kind: 'repository' | 'folder-workspace' | 'project-group'
  id: string
  label: string
}

/** What moving a host's newer projects would add, and what the server will keep as it is. */
export type HivewarddDeltaMovePreview = {
  sshTargetId: string
  environmentId: string
  added: HivewarddDeltaMoveRow[]
  /** Projects an older build changed or removed; the server keeps its own copy of these. */
  notReflected: { edited: HivewarddDeltaMoveRow[]; removed: HivewarddDeltaMoveRow[] }
  blockers: HivewarddMigrationBlocker[]
}

export type HivewarddDeltaMoveResult =
  | { outcome: 'moved'; migrationId: string }
  | { outcome: 'refused'; code: string; reason: string; blockers?: HivewarddMigrationBlocker[] }
