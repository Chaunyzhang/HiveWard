// Request shutdown without signaling; only kernel identity, owner change or PID absence proves exit.
import { setTimeout as delay } from 'node:timers/promises'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  HivewarddManagedStopRequestSchema,
  hivewarddManagedStopRequestKey,
  type HivewarddManagedStopInstance,
  type HivewarddManagedStopRequest,
  type HivewarddManagedStopVerdict
} from '../../shared/hivewardd-stop-request'
import {
  compareHivewarddProcessIdentity,
  recordedHivewarddProcessIncarnation,
  type HivewarddProcessIdentityReaders,
  type HivewarddRecordedIdentity
} from './hivewardd-process-start-time'
import { hasErrorCode, inspectProcessSignal } from '../daemon/daemon-process-inspection'
import { persistHivewarddCompletedStopReceipt } from './hivewardd-completed-stop-receipt'
import { readHivewarddManagedStopDecision } from './hivewardd-managed-stop-decision'
import { withdrawHivewarddManagedStopRequest } from './hivewardd-managed-stop-cancellation'
import {
  hivewarddInstanceLockNames,
  hivewarddManagedStopRequestPath,
  readHivewarddInstanceLockNaming,
  readHivewarddManagedStopRequest
} from './hivewardd-managed-stop-request'
import {
  HIVEWARDD_STOP_COMPLETION_POLL_ATTEMPTS,
  HIVEWARDD_STOP_COMPLETION_POLL_MS
} from './hivewardd-stop-deadlines'

type HivewarddProcessProbe = (pid: number) => 'alive' | 'missing' | 'unverifiable'

export type HivewarddManagedStopCompletionOptions = HivewarddProcessIdentityReaders & {
  probeProcess?: HivewarddProcessProbe
  sleep?: () => Promise<void>
  attempts?: number
  now?: () => Date
}

function defaultProbe(pid: number): ReturnType<HivewarddProcessProbe> {
  const signal = inspectProcessSignal(pid)
  // EPERM proves some process holds the PID; it cannot prove ours exited.
  return signal === 'occupied' ? 'alive' : signal === 'missing' ? 'missing' : 'unverifiable'
}

function observeInstance(
  instance: HivewarddManagedStopInstance,
  recorded: HivewarddRecordedIdentity,
  options: HivewarddManagedStopCompletionOptions
): HivewarddManagedStopVerdict {
  const probe = (options.probeProcess ?? defaultProbe)(instance.pid)
  if (probe !== 'alive') {
    return probe === 'missing' ? 'exited' : 'unverifiable'
  }
  // Wall-clock drift alone cannot prove PID reuse.
  const identity = compareHivewarddProcessIdentity(instance.pid, recorded, options)
  return identity === 'differs' ? 'exited' : identity === 'unproven' ? 'unverifiable' : 'live'
}

/** Recover incarnation data from the lock for older clients that omit it. */
function recordedIdentity(instance: HivewarddManagedStopInstance): HivewarddRecordedIdentity {
  if (recordedHivewarddProcessIncarnation(instance)) {
    return instance
  }
  let record: HivewarddRecordedIdentity | null = null
  try {
    record = readHivewarddInstanceLockNaming(instance)
  } catch {
    return instance
  }
  if (!record) {
    return instance
  }
  return { ...instance, ...recordedHivewarddProcessIncarnation(record), identity: record.identity }
}

export async function completeHivewarddManagedStop(
  input: HivewarddManagedStopRequest,
  options: HivewarddManagedStopCompletionOptions = {}
): Promise<HivewarddManagedStopVerdict> {
  const request = HivewarddManagedStopRequestSchema.parse(input)
  const attempts = options.attempts ?? HIVEWARDD_STOP_COMPLETION_POLL_ATTEMPTS
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 240) {
    throw new Error('hivewardd_managed_stop_invalid_attempts')
  }
  const completed = (): 'exited' => {
    persistHivewarddCompletedStopReceipt(request, (options.now ?? (() => new Date()))())
    return 'exited'
  }
  const recorded = recordedIdentity(request.instance)
  let verdict = observeInstance(request.instance, recorded, options)
  if (verdict !== 'live') {
    return verdict === 'exited' ? completed() : verdict
  }
  if (!lockStillNamesInstance(request.instance)) {
    // A live process that relinquished its lock is no longer ours to address.
    return 'unverifiable'
  }
  if (readHivewarddManagedStopDecision(request) === 'canceled') {
    return 'live'
  }
  const requestPath = hivewarddManagedStopRequestPath(request.instance)
  if (!existingRequestMatches(requestPath, request)) {
    return 'unverifiable'
  }
  if (!writeDurableSecureJsonFile(requestPath, request)) {
    throw new Error('hivewardd_managed_stop_request_permissions_unconfirmed')
  }
  // A cancel between the first check and write had no request file to remove.
  if (readHivewarddManagedStopDecision(request) === 'canceled') {
    withdrawHivewarddManagedStopRequest(request)
    return 'live'
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    await (options.sleep ?? (() => delay(HIVEWARDD_STOP_COMPLETION_POLL_MS)))()
    verdict = observeInstance(request.instance, recorded, options)
    if (verdict !== 'live') {
      return verdict === 'exited' ? completed() : verdict
    }
  }
  return 'live'
}

function lockStillNamesInstance(instance: HivewarddManagedStopInstance): boolean {
  try {
    return hivewarddInstanceLockNames(instance)
  } catch {
    return false
  }
}

function existingRequestMatches(path: string, request: HivewarddManagedStopRequest): boolean {
  try {
    return (
      hivewarddManagedStopRequestKey(readHivewarddManagedStopRequest(path)) ===
      hivewarddManagedStopRequestKey(request)
    )
  } catch (error) {
    return hasErrorCode(error, 'ENOENT')
  }
}
