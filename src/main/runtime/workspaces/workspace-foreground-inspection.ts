import { observeLaunchedAgentExit } from '../launched-agent-exit-watch'
import { HiveWardRuntimeWithListManagedWorktrees } from './managed-workspace-operations'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  describeLaunchedAgentHost,
  readLaunchedAgentForeground,
  type LaunchedAgentForeground,
  type LaunchedAgentHost
} from '../launched-agent-foreground'

export abstract class HiveWardRuntimeWithForegroundInspection extends HiveWardRuntimeWithListManagedWorktrees {
  private readonly supervisedAgentExitWatches = new Map<string, () => void>()

  watchSupervisedAgentExit(handle: string, agent: TuiAgent): void {
    const ptyId = this.getLivePtyForHandle(handle)?.record.ptyId
    if (!ptyId || this.supervisedAgentExitWatches.has(ptyId)) {
      return
    }
    const pty = this.ptysById.get(ptyId)
    const incarnation = pty?.incarnationId
    const signal = this.getPtyLifecycleSignal(ptyId)
    const forget = (): void => {
      this.supervisedAgentExitWatches.delete(ptyId)
    }
    const dispose = observeLaunchedAgentExit(this, ptyId, agent, signal, () => {
      forget()
      if (this.ptysById.get(ptyId) === pty && pty?.incarnationId === incarnation) {
        this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
      }
    })
    this.supervisedAgentExitWatches.set(ptyId, dispose)
    signal.addEventListener('abort', forget, { once: true })
  }

  launchedAgentTerminalIdentity(ptyId: string): unknown {
    return this.ptysById.get(ptyId)
  }

  /** Read at the physical owner; discard a result that outlived this runtime binding. */
  async readLaunchedAgentForeground(
    ptyId: string,
    agent: TuiAgent
  ): Promise<LaunchedAgentForeground> {
    const pty = this.ptysById.get(ptyId)
    const incarnation = pty?.incarnationId
    const host = this.launchedAgentHost(ptyId)
    const result = await readLaunchedAgentForeground(
      this.ptyController,
      host,
      ptyId,
      agent,
      incarnation ?? undefined
    )
    return this.ptysById.get(ptyId) === pty && pty?.incarnationId === incarnation
      ? result
      : 'unknown'
  }

  /** Whether the pane's execution host can find a launched agent in front: a Windows one cannot. */
  launchedAgentHostProvesAgent(ptyId: string): boolean {
    return !this.launchedAgentHost(ptyId).windows
  }

  launchedAgentHostProvesShellAlone(ptyId: string): boolean {
    return this.launchedAgentHost(ptyId).shellAloneProvable
  }

  private launchedAgentHost(ptyId: string): LaunchedAgentHost {
    const pty = this.ptysById.get(ptyId)
    return describeLaunchedAgentHost(pty, () => this.pathFlavorForPty(pty))
  }
}
