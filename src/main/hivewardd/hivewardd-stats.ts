import { feedAgentSessionStats, type AgentStatusSource } from '../stats/agent-session-stats-feed'
import { initStatsPath, StatsCollector } from '../stats/collector'
import type { HivewarddRuntimeCleanup } from './hivewardd-runtime-lifetime'

export function startHivewarddStats(
  userDataPath: string,
  hooks: AgentStatusSource,
  registerCleanup: (cleanup: HivewarddRuntimeCleanup) => void
): StatsCollector {
  initStatsPath(userDataPath)
  const stats = new StatsCollector()
  // Reverse cleanup order stops feeds/RPC before the final stats flush.
  registerCleanup(() => stats.flushAsync())
  registerCleanup(feedAgentSessionStats(stats, hooks))
  return stats
}
