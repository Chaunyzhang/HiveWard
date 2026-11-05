import { resolveTuiAgentLaunchEnv } from '../../../shared/tui-agent-launch-defaults'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { RuntimeWorkspaceCatalog } from './workspace-catalog'
import type { HiveWardRuntimeWithRefreshPtyWorktreeRecordsFromController } from '../terminal/lifecycle/pty-worktree-refresh'
import type { RuntimeAccountController } from '../runtime-account-controller'
import type { HiveWardRuntimeWithPruneMobileSessionTabGroupLayout } from '../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { HiveWardRuntimeWithGetStructuredAgentSessionCreateSupport } from '../session-tabs/structured-session-create-support'
import type { HiveWardRuntimeWithGetPtyRecordForPaneKey } from '../orchestration/terminal-pane-mail-routing'
import { HiveWardRuntimeWithStartTuiIdleVisibleReadProbe } from '../terminal/wait/terminal-wait-visible-probe'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { Repo } from '../../../shared/repo-types'
import { escalateChatWorkerError } from '../orchestration/chat-worker-error-escalation'
import type { StructuredAgentSessionRequestFailure } from '../../native-chat/agent-session-wire/structured-agent-session-request-failures'

export abstract class HiveWardRuntimeWithWorktreePsDependencies extends HiveWardRuntimeWithStartTuiIdleVisibleReadProbe {
  /** Apply the host-owning desktop's account overlay to configured agent environment. */
  protected structuredAgentLaunchEnv(
    agent: StructuredAgentId,
    settings: Pick<GlobalSettings, 'agentDefaultEnv'>
  ) {
    return {
      ...resolveTuiAgentLaunchEnv(agent, settings),
      ...this.accounts.hostLaunchEnvFor(agent)
    }
  }

  protected abstract listResolvedWorktreeSnapshot(
    ...args: Parameters<RuntimeWorkspaceCatalog['listResolvedWorktreeSnapshot']>
  ): ReturnType<RuntimeWorkspaceCatalog['listResolvedWorktreeSnapshot']>
  protected abstract refreshPtyWorktreeRecordsFromController(
    ...args: Parameters<
      HiveWardRuntimeWithRefreshPtyWorktreeRecordsFromController['refreshPtyWorktreeRecordsFromController']
    >
  ): ReturnType<
    HiveWardRuntimeWithRefreshPtyWorktreeRecordsFromController['refreshPtyWorktreeRecordsFromController']
  >
  abstract notifyFolderWorkspaceChanged(): void
  abstract notifyBranchRenamed(repoId: string): void
  abstract notifyWorktreeFolderRenamed(
    repoId: string,
    oldWorktreeId: string,
    newWorktreeId: string
  ): void
  declare getCommitMessageAgentEnvironmentResolvers: RuntimeAccountController['getCommitMessageAgentEnvironment']
  abstract refreshStructuredConversationTabTitle(
    ...args: Parameters<
      HiveWardRuntimeWithPruneMobileSessionTabGroupLayout['refreshStructuredConversationTabTitle']
    >
  ): ReturnType<
    HiveWardRuntimeWithPruneMobileSessionTabGroupLayout['refreshStructuredConversationTabTitle']
  >
  abstract resolveStructuredAgentAccountHome(
    ...args: Parameters<
      HiveWardRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentAccountHome']
    >
  ): ReturnType<
    HiveWardRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentAccountHome']
  >
  abstract resolveStructuredAgentLaunchAccountHome(
    ...args: Parameters<
      HiveWardRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentLaunchAccountHome']
    >
  ): ReturnType<
    HiveWardRuntimeWithGetStructuredAgentSessionCreateSupport['resolveStructuredAgentLaunchAccountHome']
  >
  abstract onStructuredSessionStatusForMail(
    ...args: Parameters<
      HiveWardRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionStatusForMail']
    >
  ): ReturnType<HiveWardRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionStatusForMail']>
  protected abstract assertStructuredChatAcquireAdmissible(
    record: AgentSessionRecord
  ): Promise<void>
  abstract onStructuredSessionTabHidden(
    ...args: Parameters<HiveWardRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionTabHidden']>
  ): ReturnType<HiveWardRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionTabHidden']>
  abstract structuredChatMailOwed(
    ...args: Parameters<HiveWardRuntimeWithGetPtyRecordForPaneKey['structuredChatMailOwed']>
  ): ReturnType<HiveWardRuntimeWithGetPtyRecordForPaneKey['structuredChatMailOwed']>

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }

  /** A chat worker whose request settled failed tells the Run that dispatched it. */
  onStructuredRequestFailureForErrorMail(failure: StructuredAgentSessionRequestFailure): void {
    void escalateChatWorkerError(failure, this.workerTurnStopReportDeps)
  }
}
