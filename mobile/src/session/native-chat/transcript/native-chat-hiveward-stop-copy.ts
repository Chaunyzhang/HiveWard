import type { NativeChatHiveWardStopSay } from '../../../../../src/shared/native-chat/native-chat-hiveward-stop-words'
import type { Translate } from '../../../i18n/mobile-i18n'

export function nativeChatHiveWardStopSay(t: Translate): NativeChatHiveWardStopSay {
  return (id, machine) => {
    const copy = {
      update: () =>
        t(
          'chat.hivewardStop.update',
          'HiveWard on {{machine}} restarted for an update while this response was in progress.',
          { machine }
        ),
      quit: () =>
        t(
          'chat.hivewardStop.quit',
          'HiveWard on {{machine}} was closed while this response was in progress.',
          { machine }
        ),
      crash: () =>
        t(
          'chat.hivewardStop.crash',
          'HiveWard on {{machine}} stopped unexpectedly while this response was in progress.',
          { machine }
        ),
      remote: () =>
        t(
          'chat.hivewardStop.remote',
          'HiveWard on {{machine}} stopped while this response was in progress.',
          { machine }
        ),
      canContinue: () => t('chat.hivewardStop.canContinue', 'You can continue in this conversation.'),
      unnamedServer: () => t('chat.hivewardStop.unnamedServer', 'the remote server')
    }
    return copy[id]()
  }
}
