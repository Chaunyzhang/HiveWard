// Resumed stale holders must prove their generation on-host before every step, preventing writes or release under a successor's fence.
import { AsyncLocalStorage } from 'node:async_hooks'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { isSshCommandExitError } from '../../ssh/remote-exec/remote-exec-command'

export const HIVEWARDD_FENCE_OWNER_FILENAME = '.hiveward-fence-owner'
export const HIVEWARDD_FENCE_LOST_MARKER = '__HIVEWARDD_FENCE_LOST__'
/** EX_TEMPFAIL: this superseded generation cannot retry its step. */
export const HIVEWARDD_FENCE_LOST_EXIT = 75

export type HivewarddFence = { lockDir: string; token: string }

const scope = new AsyncLocalStorage<HivewarddFence>()

export function runWithHivewarddFence<T>(fence: HivewarddFence, run: () => Promise<T>): Promise<T> {
  return scope.run(fence, run)
}

export function currentHivewarddFence(): HivewarddFence | null {
  return scope.getStore() ?? null
}

export class HivewarddFenceLostError extends Error {
  constructor() {
    super(
      "This run's activation fence was taken over by another run, so it stopped before changing the host."
    )
    this.name = 'HivewarddFenceLostError'
  }
}

export function posixHivewarddFenceOwnedTest(fence: HivewarddFence): string {
  const owner = quotePosixShell(
    `${fence.lockDir.replace(/\/+$/u, '')}/${HIVEWARDD_FENCE_OWNER_FILENAME}`
  )
  return `[ "$(cat ${owner} 2>/dev/null)" = ${quotePosixShell(fence.token)} ]`
}

export function posixHivewarddFenceGuard(fence: HivewarddFence): string {
  return `${posixHivewarddFenceOwnedTest(fence)} || { echo ${HIVEWARDD_FENCE_LOST_MARKER}; exit ${HIVEWARDD_FENCE_LOST_EXIT}; };`
}

/** Use exit status and stdout; error messages quote commands containing the marker even when no guard failed. */
export function isHivewarddFenceLost(error: unknown): boolean {
  if (!isSshCommandExitError(error)) {
    return false
  }
  // `powershell -Command` reports any nonzero native exit as 1.
  const exited = error.exitCode === HIVEWARDD_FENCE_LOST_EXIT || error.exitCode === 1
  return exited && error.stdout.trim().split(/\r?\n/u).at(-1) === HIVEWARDD_FENCE_LOST_MARKER
}
