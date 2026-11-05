// Exit 0 means JSON was printed; read its outcome. Exit 64 is invalid input, 1 is failure without exit proof.
import {
  HIVEWARDD_CANCEL_MANAGED_STOP_FLAG,
  HIVEWARDD_COMPLETE_MANAGED_STOP_FLAG,
  HIVEWARDD_MANAGED_STOP_REQUEST_FILE_FLAG,
  HivewarddManagedStopRequestSchema,
  type HivewarddManagedStopCancellation,
  type HivewarddManagedStopCompletion,
  type HivewarddManagedStopRequest
} from '../../shared/hivewardd-stop-request'
import { cancelHivewarddManagedStop } from './hivewardd-managed-stop-cancellation'
import { readHivewarddCompletedStopReceipt } from './hivewardd-completed-stop-receipt'
import { readHivewarddManagedStopRequest } from './hivewardd-managed-stop-request'
import { ZodError } from 'zod'
import {
  completeHivewarddManagedStop,
  type HivewarddManagedStopCompletionOptions
} from './hivewardd-managed-stop-completion'

export async function runHivewarddManagedStopCommand(
  argv: readonly string[],
  options: HivewarddManagedStopCompletionOptions = {}
): Promise<HivewarddManagedStopCompletion> {
  const request = parseRequestArgument(argv, HIVEWARDD_COMPLETE_MANAGED_STOP_FLAG)
  const verdict = await completeHivewarddManagedStop(request, options)
  const retirement =
    verdict === 'exited' && request.retireIdleDaemon
      ? readHivewarddCompletedStopReceipt(request)?.retirement
      : undefined
  const completion: HivewarddManagedStopCompletion = {
    ...request,
    kind: 'hivewardd_managed_stop_completion',
    verdict,
    receiptPersisted: verdict === 'exited',
    ...(retirement ? { retirement } : {})
  }
  process.stdout.write(`${JSON.stringify(completion)}\n`)
  return completion
}

export function runHivewarddManagedStopCancelCommand(
  argv: readonly string[]
): HivewarddManagedStopCancellation {
  const request = parseRequestArgument(argv, HIVEWARDD_CANCEL_MANAGED_STOP_FLAG)
  const cancellation: HivewarddManagedStopCancellation = {
    ...request,
    kind: 'hivewardd_managed_stop_cancellation',
    outcome: cancelHivewarddManagedStop(request)
  }
  process.stdout.write(`${JSON.stringify(cancellation)}\n`)
  return cancellation
}

function parseRequestArgument(argv: readonly string[], flag: string): HivewarddManagedStopRequest {
  if (argv[0] !== flag) {
    throw new Error('hivewardd_managed_stop_invalid_arguments')
  }
  if (argv[1] === HIVEWARDD_MANAGED_STOP_REQUEST_FILE_FLAG) {
    if (argv.length !== 3 || !argv[2]) {
      throw new Error('hivewardd_managed_stop_invalid_arguments')
    }
    return readHivewarddManagedStopRequest(argv[2])
  }
  if (argv.length !== 2 || !argv[1]) {
    throw new Error('hivewardd_managed_stop_invalid_arguments')
  }
  return HivewarddManagedStopRequestSchema.parse(JSON.parse(argv[1]))
}

export const HIVEWARDD_MANAGED_STOP_EXIT_VERDICT = 0
export const HIVEWARDD_MANAGED_STOP_EXIT_FAILED = 1
export const HIVEWARDD_MANAGED_STOP_EXIT_USAGE = 64

export async function runHivewarddManagedStopCommandAndExit(argv: readonly string[]): Promise<void> {
  let code = HIVEWARDD_MANAGED_STOP_EXIT_VERDICT
  try {
    if (argv[0] === HIVEWARDD_CANCEL_MANAGED_STOP_FLAG) {
      runHivewarddManagedStopCancelCommand(argv)
    } else {
      await runHivewarddManagedStopCommand(argv)
    }
  } catch (error) {
    console.error('hivewardd: managed stop failed:', error)
    code =
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      (error instanceof Error && error.message === 'hivewardd_managed_stop_invalid_arguments')
        ? HIVEWARDD_MANAGED_STOP_EXIT_USAGE
        : HIVEWARDD_MANAGED_STOP_EXIT_FAILED
  }
  // Drain stdout before exit: callers read the result to EOF.
  process.stdout.write('', () => process.exit(code))
}
