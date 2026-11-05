import type { GlobalSettings } from './global-settings-types'

/** 老板为第 0 层，默认允许 CEO → Leader → 下属 → 孙级。 */
export const NESTED_WORKER_MAX_DEPTH_DEFAULT = 4

/** Root coordinators are depth 0; the first generation of workers is depth 1. */
export const ROOT_DISPATCH_DEPTH = 0

export const NESTED_WORKER_DEPTH_EXCEEDED_CODE = 'nested_worker_depth_exceeded'

export function nestedWorkerDepthExceededMessage(childDepth: number, maxDepth: number): string {
  // Explicitly require doing the work locally or refused workers loop on unavailable dispatch.
  return (
    `Sub-worker dispatch is not permitted at depth ${childDepth} (max ${maxDepth}). ` +
    'Complete this task yourself.'
  )
}

export const NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS: readonly string[] = [
  'Do the work in this terminal instead of dispatching a sub-worker.',
  "HiveWard's current nesting limit blocks a deeper dispatch; ask your manager to do the work or reassign it to a shallower worker."
]

/** Reject unsafe/noninteger values below one to the default; malformed settings cannot disable the depth fence. */
export function resolveNestedWorkerMaxDepth(
  settings: Pick<GlobalSettings, 'nestedWorkerMaxDepth'> | null | undefined
): number {
  const raw = settings?.nestedWorkerMaxDepth
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
    return NESTED_WORKER_MAX_DEPTH_DEFAULT
  }
  return raw
}
