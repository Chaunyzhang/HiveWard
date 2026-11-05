import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  parseChatUiLaunchTipAudience,
  type ChatUiLaunchTipAudience
} from '../../../shared/native-chat/chat-ui-launch-tip-audience'
import { carriedChatUiLaunchSettings } from '../../../shared/native-chat/native-chat-providers'
import { savedChatUiWithTerminalDefaultView } from '../applying-settings/terminal-settings-migrations'

import type { StoreRuntimeState } from './store-runtime-state'

type LoadedCohortMigrationOperationsRuntime = Pick<StoreRuntimeState, 'loadNeedsSave'>

export class LoadedCohortMigrationOperations {
  constructor(private readonly runtime: LoadedCohortMigrationOperationsRuntime) {}

  migrateTabSwitchKeybindings(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    const existing = state.settings?.tabSwitchKeybindingSeed
    if (existing === 'pending' || existing === 'done') {
      return state
    }
    // Persist the frozen cohort before the first file makes a fresh install appear existing.
    this.runtime.loadNeedsSave = true
    return {
      ...state,
      settings: {
        ...state.settings,
        // Existing installs seed old chords; fresh ones use current defaults.
        tabSwitchKeybindingSeed: fileExistedOnLoad ? 'pending' : 'done'
      }
    }
  }

  /** Reads the retired Chat UI switch from the raw profile, before load strips it. */
  captureChatUiLaunchTipAudience(savedProfile: unknown): ChatUiLaunchTipAudience {
    const saved = isRecord(savedProfile) ? savedProfile.chatUiLaunchTipAudience : undefined
    const kept = saved === undefined ? null : parseChatUiLaunchTipAudience(saved)
    if (kept) {
      return kept
    }
    // Persist this decision before later settings changes can alter the apparent audience.
    this.runtime.loadNeedsSave = true
    if (!isRecord(savedProfile)) {
      return { version: 1, membership: 'excluded', basis: 'new-profile' }
    }
    if (saved !== undefined) {
      // Never rederive a damaged audience record from current settings.
      return { version: 1, membership: 'excluded', basis: 'unreadable-record' }
    }
    const settings = isRecord(savedProfile.settings) ? savedProfile.settings : undefined
    // Opt-ins saved with new tabs opening in the terminal were kept on the terminal, so they count as off.
    const chatUiOn =
      settings?.experimentalNativeChat === true && !savedChatUiWithTerminalDefaultView(settings)
    return { version: 1, membership: 'eligible', basis: chatUiOn ? 'chat-ui-on' : 'chat-ui-off' }
  }

  /** Runs with the audience capture that first records the profile, so it applies once and in the same save. */
  carryChatUiChoices(
    state: PersistedState,
    savedProfile: unknown,
    audience: ChatUiLaunchTipAudience
  ): PersistedState {
    if (
      !isRecord(savedProfile) ||
      savedProfile.chatUiLaunchTipAudience !== undefined ||
      (audience.basis !== 'chat-ui-on' && audience.basis !== 'chat-ui-off')
    ) {
      return state
    }
    const saved = isRecord(savedProfile.settings) ? savedProfile.settings : undefined
    const launchSettings = carriedChatUiLaunchSettings(
      saved?.nativeChatProviders,
      audience.basis === 'chat-ui-on'
    )
    this.runtime.loadNeedsSave = true
    return { ...state, settings: { ...state.settings, ...launchSettings } }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
