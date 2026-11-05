import type { WorktreeCreateTiming } from '../shared/worktree/create-types'
import type { WorkspaceCreateEntryPoint } from '../shared/worktree/create-timing-vocabulary'
import {
  createWorktreeCreateTimingRecorder,
  type WorktreeCreateTimingRecorder
} from './worktree-create-timing'
import { beginWorktreeCreate } from './worktree-create-concurrency'

export type WorkspaceCreateTelemetry = {
  readonly timing: WorktreeCreateTimingRecorder
  succeeded(timing?: WorktreeCreateTiming): void
  failed(error: unknown): void
}

export type WorkspaceCreateTelemetryArgs = {
  source: unknown
  entryPoint: WorkspaceCreateEntryPoint
  repoPath: string
  fromExistingBranch: boolean
  /** Folder workspaces omit Git timing and disk-concurrency fields. */
  isFolder: boolean
}

export function beginWorkspaceCreateTelemetry(
  args: WorkspaceCreateTelemetryArgs
): WorkspaceCreateTelemetry {
  const inFlight = args.isFolder ? null : beginWorktreeCreate()
  const timing = createWorktreeCreateTimingRecorder(undefined, inFlight ?? undefined)
  const settle = () => {
    inFlight?.end()
  }
  return { timing, succeeded: settle, failed: settle }
}

export type RuntimeWorkspaceCreateEvents = {
  begin(repoPath: string): WorktreeCreateTimingRecorder
}

/** Settle concurrency counts before returning, so subsequent preparation work is excluded. */
export async function trackRuntimeWorkspaceCreate<T>(
  request: { telemetrySource?: unknown; baseBranch?: string },
  perform: (events: RuntimeWorkspaceCreateEvents) => Promise<T>
): Promise<T> {
  const session: { current?: WorkspaceCreateTelemetry } = {}
  try {
    const result = await perform({
      begin(repoPath) {
        session.current = beginWorkspaceCreateTelemetry({
          source: request.telemetrySource,
          entryPoint: 'runtime',
          repoPath,
          fromExistingBranch:
            typeof request.baseBranch === 'string' && request.baseBranch.length > 0,
          isFolder: false
        })
        return session.current.timing
      }
    })
    session.current?.succeeded()
    return result
  } catch (error) {
    session.current?.failed(error)
    throw error
  }
}
