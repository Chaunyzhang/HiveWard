import { app, powerMonitor } from 'electron'
import { join } from 'node:path'
import { AgentAwakeService } from '../agent-awake-service'
import { normalizeComputerAwakeMode } from '../../shared/computer-awake-mode'
import { registerSystemResumeBroadcast } from '../system-resume-broadcast'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import {
  listCapableSharedControlSockets,
  startDesktopPresenceReporter
} from '../notifications/desktop-presence-reporter'
import { agentHookServer } from '../agent-hooks/server'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/hook-status-session-tabs-republish'
import { initObservability } from '../observability'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { reportPreviousHangDetection } from '../hang-watchdog/previous-hang-detection'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { recoverPendingSkillTransactions } from '../skills/skill-transaction-startup-recovery'
import { StatsCollector } from '../stats/collector'
import { feedAgentSessionStats } from '../stats/agent-session-stats-feed'
import { ClaudeUsageStore } from '../claude-usage/store'
import { CodexUsageStore } from '../codex-usage/store'
import { OpenCodeUsageStore } from '../opencode-usage/store'
import { MuseUsageStore } from '../muse-usage/store'
import { installRepoMaintenanceIdleGate } from '../repo-maintenance-idle-gate'
import { mainProcessState as state } from './main-process-state'

export function initializeMainProcessObservers(): void {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before observers')
  }
  state.unsubscribeSystemResumeBroadcast = registerSystemResumeBroadcast()
  state.stopDesktopPresenceReporter = startDesktopPresenceReporter({
    readAway: () => readDesktopAwayState(powerMonitor),
    listTargets: listCapableSharedControlSockets,
    subscribePowerEvents: ({ away, back }) => {
      powerMonitor.on('suspend', away)
      powerMonitor.on('lock-screen', away)
      powerMonitor.on('resume', back)
      powerMonitor.on('unlock-screen', back)
      return () => {
        powerMonitor.off('suspend', away)
        powerMonitor.off('lock-screen', away)
        powerMonitor.off('resume', back)
        powerMonitor.off('unlock-screen', back)
      }
    }
  })
  state.agentAwakeService = new AgentAwakeService()
  state.agentAwakeService.setMode(
    normalizeComputerAwakeMode(
      store.getSettings().computerAwakeMode,
      store.getSettings().keepComputerAwakeWhileAgentsRun
    )
  )
  // Hydrated rows preserve UI only; only this runtime's live hook events may keep the machine awake.
  state.agentAwakeService.setStatuses([])
  state.uninstallRepoMaintenanceIdleGate = installRepoMaintenanceIdleGate({
    isQuitting: () => state.isQuitting,
    getWorkingAgentCount: () => state.agentAwakeService?.getWorkingAgentCount() ?? 0
  })
  const unsubscribeStatusChanges = agentHookServer.subscribeStatusChanges((statuses) => {
    state.agentAwakeService?.setStatuses(statuses)
  })
  const unsubscribeStatusFreshness = agentHookServer.subscribeStatusFreshness((status) => {
    state.agentAwakeService?.observeStatusFreshness(status)
  })
  const uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => state.runtime
  )
  state.unsubscribeAgentAwakeStatusChanges = () => {
    unsubscribeStatusChanges()
    unsubscribeStatusFreshness()
    uninstallHookStatusRepublish()
  }
  // IPC 与运行时开始工作前初始化本地诊断日志。
  initObservability()
  recordDurableCrashBreadcrumb('main_process_lifecycle_started', {
    packaged: app.isPackaged,
    platform: process.platform
  })
  state.hangDetection = reportPreviousHangDetection(getCanonicalUserDataPath())
  state.skillTransactionRecovery = recoverPendingSkillTransactions(
    join(app.getPath('userData'), 'skill-installs')
  )
  void state.skillTransactionRecovery
    .then((report) => {
      const result = report as {
        scanned: number
        recovered: number
        failures: { code: string }[]
        truncated: boolean
      }
      if (result.scanned || result.failures.length || result.truncated) {
        console.info('[skills] startup transaction recovery:', {
          scanned: result.scanned,
          recovered: result.recovered,
          failures: result.failures.map((failure) => failure.code),
          truncated: result.truncated
        })
      }
    })
    .catch((error) => console.warn('[skills] startup transaction recovery failed:', error))
  state.stats = new StatsCollector()
  feedAgentSessionStats(state.stats, agentHookServer)
  state.claudeUsage = new ClaudeUsageStore(store)
  state.codexUsage = new CodexUsageStore(store)
  state.openCodeUsage = new OpenCodeUsageStore(store)
  state.museUsage = new MuseUsageStore(store)
}
