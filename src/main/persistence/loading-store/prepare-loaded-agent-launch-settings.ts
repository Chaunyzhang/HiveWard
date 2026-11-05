import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { hasUnsupportedTuiAgentArgs } from '../../../shared/tui-agent-launch-defaults'
import { hasTypedAgentPermission } from '../../../shared/tui-agent-permission-choice'
import { migrateAgentPermissionChoice } from '../../../shared/tui-agent-permission-lift'
import { migrateAgentYoloDefaults } from '../applying-settings/terminal-settings-migrations'

export type PreparedAgentLaunchSettings = {
  migratedAgentYoloDefaults: Pick<
    GlobalSettings,
    | 'agentDefaultArgs'
    | 'agentDefaultEnv'
    | 'agentYoloDefaultsMigrated'
    | 'agentOpencodeAutoDefaultsMigrated'
  >
  migratedAgentPermission: ReturnType<typeof migrateAgentPermissionChoice>
}

/** One-shot launch-profile migrations, kept out of the profile loader's line budget. */
export function prepareLoadedAgentLaunchSettings(
  parsed: PersistedState,
  markNeedsSave: () => void,
  platform: NodeJS.Platform = process.platform
): PreparedAgentLaunchSettings {
  const migratedAgentYoloDefaults = migrateAgentYoloDefaults(parsed.settings)
  const migratedAgentPermission = migrateAgentPermissionChoice(
    {
      ...migratedAgentYoloDefaults,
      agentLaunchChoices: parsed.settings?.agentLaunchChoices,
      agentPermissionDefault: parsed.settings?.agentPermissionDefault,
      agentPermissionOverrides: parsed.settings?.agentPermissionOverrides
    },
    platform
  )
  if (
    parsed.settings?.agentYoloDefaultsMigrated !== true ||
    parsed.settings?.agentOpencodeAutoDefaultsMigrated !== true ||
    !hasTypedAgentPermission(parsed.settings) ||
    parsed.settings?.agentLaunchChoices === undefined ||
    JSON.stringify(parsed.settings.agentLaunchChoices) !==
      JSON.stringify(migratedAgentPermission.agentLaunchChoices) ||
    parsed.settings?.agentDefaultArgs?.devin !==
      migratedAgentYoloDefaults.agentDefaultArgs?.devin ||
    hasUnsupportedTuiAgentArgs('opencode', parsed.settings?.agentDefaultArgs?.opencode) ||
    hasUnsupportedTuiAgentArgs('kilo', parsed.settings?.agentDefaultArgs?.kilo)
  ) {
    markNeedsSave()
  }
  return { migratedAgentYoloDefaults, migratedAgentPermission }
}
