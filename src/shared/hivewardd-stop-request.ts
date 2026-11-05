/** Stop files reach only the watching hivewardd; signals from stale PID records could stop an unrelated reused process. */
import { z } from 'zod'
import { openEnum } from './zod-salvage'

/** Plain request in the slot directory: the same graceful stop as SIGTERM. */
export const HIVEWARDD_STOP_REQUEST_FILENAME = '.hivewardd-stop-request'
/** Prefix of an instance-bound request in the data root; older listeners never match it. */
export const HIVEWARDD_MANAGED_STOP_REQUEST_PREFIX = '.hivewardd-managed-stop-request'
export const HIVEWARDD_MANAGED_STOP_REQUEST_MAX_BYTES = 32 * 1024
export const HIVEWARDD_STOP_RECEIPTS_DIRNAME = 'hivewardd-stop-receipts'
export const HIVEWARDD_COMPLETE_MANAGED_STOP_FLAG = '--complete-managed-stop'
/** Names a staged request file instead of inline JSON; Windows hosts never put the JSON on argv. */
export const HIVEWARDD_MANAGED_STOP_REQUEST_FILE_FLAG = '--request-file'

/** One hivewardd process: its PID, start time, and the instance lock record it published. */
export const HivewarddManagedStopInstanceSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  startedAtMs: z.number().finite().nonnegative().nullable(),
  /** Linux only, copied from the lock; older clients omit it and older slots drop it. */
  linuxStartTicks: z.string().regex(/^\d+$/).max(32).optional().catch(undefined),
  bootId: z.string().min(1).max(255).optional().catch(undefined),
  nonce: z.string().min(1).max(255),
  lockPath: z.string().min(1).max(4096)
})

// Older slots drop newer optional request fields rather than refuse the stop.
export const HivewarddManagedStopRequestSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.uuid(),
  version: z.string().min(1).max(255),
  runtimeId: z.string().min(1).max(255),
  instance: HivewarddManagedStopInstanceSchema,
  /** Best effort: also retire the terminal daemon if it is provably idle. Never blocks the stop. */
  retireIdleDaemon: z.literal(true).optional()
})

export type HivewarddManagedStopInstance = z.infer<typeof HivewarddManagedStopInstanceSchema>
export type HivewarddManagedStopRequest = z.infer<typeof HivewarddManagedStopRequestSchema>

/** Equality key for a request; omits the incarnation, which an older client recovering it drops. */
export function hivewarddManagedStopRequestKey(request: HivewarddManagedStopRequest): string {
  const { instance, ...rest } = HivewarddManagedStopRequestSchema.parse(request)
  const { linuxStartTicks: _ticks, bootId: _bootId, ...bound } = instance
  return JSON.stringify({ ...rest, instance: bound })
}
/** What a stopping hivewardd must match before a managed request may stop it. */
export type HivewarddManagedStopContext = Omit<
  HivewarddManagedStopRequest,
  'schemaVersion' | 'transactionId'
>

const STOP_VERDICTS = ['live', 'unverifiable', 'exited'] as const
const RETIREMENT_VERDICTS = ['retired', 'live', 'unverifiable'] as const

/** The execution host's verdict; `exited` only on proof, never on silence. */
export const HivewarddManagedStopVerdictSchema = z.enum(STOP_VERDICTS)

/** `retired` only when the daemon accepted; a busy daemon stays up and keeps its terminals. */
export const HivewarddDaemonRetirementVerdictSchema = z.enum(RETIREMENT_VERDICTS)

// Read by clients older than the slot that printed them: unknown fields and arms degrade.
const stopReplyRequestFields = HivewarddManagedStopRequestSchema.shape

export const HivewarddManagedStopCompletionSchema = z.object({
  ...stopReplyRequestFields,
  kind: z.literal('hivewardd_managed_stop_completion'),
  verdict: openEnum(STOP_VERDICTS, 'unverifiable'),
  receiptPersisted: z.boolean(),
  /** For a request that asked to retire the daemon, the outcome its receipt recorded. */
  retirement: openEnum(RETIREMENT_VERDICTS, 'unverifiable').optional()
})

/** What the stopping hivewardd observed about its daemon, written before it exits. */
export const HivewarddDaemonRetirementRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('hivewardd_managed_stop_retirement'),
  request: HivewarddManagedStopRequestSchema,
  retirement: HivewarddDaemonRetirementVerdictSchema,
  liveSessions: z.number().int().nonnegative().nullable(),
  reason: z.string().max(4096).nullable()
})

export const HivewarddCompletedStopReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('hivewardd_managed_stop_completed'),
  request: HivewarddManagedStopRequestSchema,
  exitedAt: z.iso.datetime({ offset: true }),
  /** Present only when the request asked to retire the daemon. */
  retirement: HivewarddDaemonRetirementVerdictSchema.optional()
})

export type HivewarddManagedStopVerdict = z.infer<typeof HivewarddManagedStopVerdictSchema>
export type HivewarddManagedStopCompletion = z.infer<typeof HivewarddManagedStopCompletionSchema>
export type HivewarddCompletedStopReceipt = z.infer<typeof HivewarddCompletedStopReceiptSchema>
export type HivewarddDaemonRetirementVerdict = z.infer<typeof HivewarddDaemonRetirementVerdictSchema>
export type HivewarddDaemonRetirementRecord = z.infer<typeof HivewarddDaemonRetirementRecordSchema>

export const HIVEWARDD_CANCEL_MANAGED_STOP_FLAG = '--cancel-managed-stop'
/** Readiness `health.stopRequests`: this build consumes stop files and both commands above. */
export const HIVEWARDD_STOP_REQUESTS_CAPABILITY = 1

/** Exclusive per-transaction creation ensures only hivewardd dispatch or client cancellation can win. */
export const HivewarddManagedStopDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('hivewardd_managed_stop_decision'),
  request: HivewarddManagedStopRequestSchema,
  decision: z.enum(['dispatched', 'canceled'])
})

/** `dispatched` means hivewardd already acted on the request; the caller must await its exit. */
export const HivewarddManagedStopCancellationSchema = z.object({
  ...stopReplyRequestFields,
  kind: z.literal('hivewardd_managed_stop_cancellation'),
  // Unknown degrades to `dispatched`: the caller then awaits exit rather than assume a cancel.
  outcome: openEnum(['canceled', 'dispatched'], 'dispatched')
})

export type HivewarddManagedStopDecision = z.infer<typeof HivewarddManagedStopDecisionSchema>
export type HivewarddManagedStopCancellation = z.infer<typeof HivewarddManagedStopCancellationSchema>
