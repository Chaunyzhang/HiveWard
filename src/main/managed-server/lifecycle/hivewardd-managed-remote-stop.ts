// Readiness and instance-lock records must agree before the slot's own build requests a stop.
import { randomUUID } from 'node:crypto'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { selectHivewarddSlotRuntimeCommand } from '../install/hivewardd-remote-runtime'
import {
  parseHivewarddReadinessWaitOutput,
  readHivewarddReadinessNowCommand
} from '../install/hivewardd-remote-readiness-wait'
import { execHivewarddRemote } from '../install/hivewardd-remote-runtime-control'
import { readBoundedHivewarddRemoteRecord } from '../install/hivewardd-remote-record-file'
import { hivewarddSlotDir, type HivewarddSlotOptions } from '../../ssh/hivewardd-recovery-slot'
import { isWindowsRemoteHost, joinRemotePath } from '../../ssh/ssh-remote-platform'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import {
  hivewarddWindowsNodeCommandLine,
  hivewarddWindowsSlotOpCommand,
  readHivewarddWindowsEncodedAnswer
} from '../install/hivewardd-remote-windows-node'
import { HIVEWARDD_WINDOWS_RUNTIME_MARKER } from '../host-state/hivewardd-windows-host-script'
import { HIVEWARDD_LOCK_FILE_NAME, parseHivewarddInstanceLockRecord } from '../../hivewardd/hivewardd-instance-lock'
import {
  HIVEWARDD_CANCEL_MANAGED_STOP_FLAG,
  HIVEWARDD_COMPLETE_MANAGED_STOP_FLAG,
  HIVEWARDD_MANAGED_STOP_REQUEST_FILE_FLAG,
  HIVEWARDD_STOP_REQUESTS_CAPABILITY,
  HivewarddManagedStopCancellationSchema,
  HivewarddManagedStopCompletionSchema,
  type HivewarddManagedStopCancellation,
  type HivewarddManagedStopCompletion,
  type HivewarddManagedStopContext,
  type HivewarddManagedStopRequest
} from '../../../shared/hivewardd-stop-request'

const LOCK_RECORD_MAX_BYTES = 64 * 1024

export type HivewarddManagedStopTarget =
  | { state: 'ready'; context: HivewarddManagedStopContext }
  | { state: 'refused'; verdict: 'unverifiable'; code: string; reason: string }

function refused(code: string, reason: string): HivewarddManagedStopTarget {
  return { state: 'refused', verdict: 'unverifiable', code, reason }
}

export async function readRemoteHivewarddManagedStopTarget(
  options: HivewarddSlotOptions,
  version: string
): Promise<HivewarddManagedStopTarget> {
  const slotDir = hivewarddSlotDir(options, version)
  const readiness = parseHivewarddReadinessWaitOutput(
    options.host,
    await execHivewarddRemote(options, readHivewarddReadinessNowCommand(options.host, slotDir))
  )
  if (readiness.state !== 'ready' || !readiness.readiness.health) {
    return refused(
      'hivewardd_managed_stop_readiness_unverifiable',
      `hivewardd ${version} has no readable readiness record, so the running instance is unknown.`
    )
  }
  const { health, runtimeId } = readiness.readiness
  if (health.stopRequests !== HIVEWARDD_STOP_REQUESTS_CAPABILITY) {
    return refused(
      'hivewardd_managed_stop_unsupported',
      `hivewardd ${version} predates managed stop requests; it can only be stopped by signal.`
    )
  }
  const lockPath = joinRemotePath(options.host, options.userDataDir, HIVEWARDD_LOCK_FILE_NAME)
  const lockRead = await readBoundedHivewarddRemoteRecord(options, lockPath, LOCK_RECORD_MAX_BYTES)
  const lock = lockRead.state === 'present' ? parseHivewarddInstanceLockRecord(lockRead.raw) : null
  if (!lock || lock.pid !== health.pid || !runtimeId) {
    return refused(
      'hivewardd_managed_stop_instance_unverifiable',
      `The instance lock does not name the hivewardd ${version} that published readiness.`
    )
  }
  return {
    state: 'ready',
    context: {
      version,
      runtimeId,
      instance: {
        pid: lock.pid,
        startedAtMs: lock.startedAtMs,
        // Newer slots use boot/start ticks to avoid wall-clock drift; older readers drop them.
        ...(lock.linuxStartTicks && lock.bootId
          ? { linuxStartTicks: lock.linuxStartTicks, bootId: lock.bootId }
          : {}),
        nonce: lock.nonce,
        lockPath
      }
    }
  }
}

export async function completeRemoteHivewarddManagedStop(
  options: HivewarddSlotOptions,
  request: HivewarddManagedStopRequest
): Promise<HivewarddManagedStopCompletion> {
  return HivewarddManagedStopCompletionSchema.parse(
    await runSlotCommand(options, request, HIVEWARDD_COMPLETE_MANAGED_STOP_FLAG)
  )
}

export async function cancelRemoteHivewarddManagedStop(
  options: HivewarddSlotOptions,
  request: HivewarddManagedStopRequest
): Promise<HivewarddManagedStopCancellation> {
  return HivewarddManagedStopCancellationSchema.parse(
    await runSlotCommand(options, request, HIVEWARDD_CANCEL_MANAGED_STOP_FLAG)
  )
}

// The slot's own build owns its stop-request format.
async function runSlotCommand(
  options: HivewarddSlotOptions,
  request: HivewarddManagedStopRequest,
  flag: string
): Promise<unknown> {
  const slotDir = hivewarddSlotDir(options, request.version)
  const entry = joinRemotePath(options.host, slotDir, 'hivewardd.js')
  const output = isWindowsRemoteHost(options.host)
    ? await runWindowsSlotCommand(options, slotDir, entry, request, flag)
    : await execHivewarddRemote(
        options,
        `${selectHivewarddSlotRuntimeCommand(options.host, slotDir, options.nodePath)} && ` +
          `"$hivewardd_runtime" ${quotePosixShell(entry)} ${flag} ${quotePosixShell(JSON.stringify(request))}`
      )
  const line = output
    .trim()
    .split('\n')
    .findLast((candidate) => candidate.trim().startsWith('{'))
  if (!line) {
    throw new Error('hivewardd managed stop command returned no verifiable answer')
  }
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('hivewardd managed stop command returned no verifiable answer')
  }
  if (!('transactionId' in parsed) || parsed.transactionId !== request.transactionId) {
    throw new Error('hivewardd managed stop command answered another transaction')
  }
  return parsed
}

// Stage JSON on Windows to avoid two command-line quoting layers.
async function runWindowsSlotCommand(
  options: HivewarddSlotOptions,
  slotDir: string,
  entry: string,
  request: HivewarddManagedStopRequest,
  flag: string
): Promise<string> {
  const runtime = readHivewarddWindowsEncodedAnswer(
    await execHivewarddRemote(
      options,
      hivewarddWindowsSlotOpCommand(options.host, slotDir, 'slot-runtime', [slotDir])
    ),
    HIVEWARDD_WINDOWS_RUNTIME_MARKER
  )
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this hivewardd slot needs.')
  }
  const staged = joinRemotePath(options.host, slotDir, `.hivewardd-stop-command-${randomUUID()}.json`)
  let removeStaged = true
  try {
    await options.conn.writeFile(staged, JSON.stringify(request), {
      hostPlatform: options.host,
      signal: options.signal
    })
    return await execHivewarddRemote(
      options,
      hivewarddWindowsNodeCommandLine(runtime, [
        entry,
        flag,
        HIVEWARDD_MANAGED_STOP_REQUEST_FILE_FLAG,
        staged
      ])
    )
  } catch (error) {
    // Unconfirmed commands may still be reading the staged request.
    removeStaged = !isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (removeStaged) {
      await execHivewarddRemote(
        options,
        hivewarddWindowsSlotOpCommand(options.host, slotDir, 'remove-file', [staged])
      ).catch(() => {})
    }
  }
}
