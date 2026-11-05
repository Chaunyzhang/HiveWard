import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import {
  AGENT_SESSION_HIVEWARD_STOP_PRESENTATION,
  isAgentSessionHiveWardStopCause
} from '../../../shared/agent-session/lifecycle/agent-session-hiveward-stop'
import type { AgentSessionResumeTrigger } from '../../../shared/agent-session/lifecycle/agent-session-resume-marker'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session/failures/agent-session-failure-words'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type {
  AgentJournalRenderItem,
  AgentJournalStatusItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { hivewardShutdownRowClientMessageId } from '../../../shared/native-chat/native-chat-hiveward-stop-cut'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

type HiveWardStopRowJournal = Pick<AgentSessionJournal, 'snapshot' | 'appendItem'>

/** Keep legacy stop wording/tone alongside the cause that newer clients render muted. */
export function hivewardStopRowBody(
  context: AgentSessionFailureWordsContext | undefined,
  hivewardEnd: unknown
): AgentJournalStatusItem {
  return {
    kind: 'status',
    ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
      ...context,
      surface: 'row'
    }),
    tone: 'error',
    ...(isAgentSessionHiveWardStopCause(hivewardEnd)
      ? { presentation: AGENT_SESSION_HIVEWARD_STOP_PRESENTATION, hivewardStop: { cause: hivewardEnd } }
      : {})
  }
}

export function runningRootTurnItemId(
  journal: Pick<AgentSessionJournal, 'snapshot'>
): string | null {
  return (
    journal
      .snapshot()
      .items.findLast(
        (item) =>
          isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)?.state === 'running'
      )?.itemId ?? null
  )
}

function cutByNobody(item: AgentJournalRenderItem | undefined): boolean {
  const turn = item ? readAgentJournalTurn(item.body) : null
  return (
    turn !== null &&
    agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) ===
      'interruption'
  )
}

/** Explain quit-cut turns after settlement, excluding completed/personal stops; never block quit on failure. */
export async function recordStructuredAgentSessionShutdownCut(input: {
  journal: HiveWardStopRowJournal
  sessionId: string
  /** Stopped-child fence keys row identity. */
  fence: number
  /** Current lease fence, advanced beyond the stopped child. */
  rowFence: number
  generation: string
  turnItemId: string | null
  trigger: AgentSessionResumeTrigger
  failureTextContext?: AgentSessionFailureWordsContext
  logger: StructuredAgentSessionLogger
}): Promise<void> {
  try {
    const { turnItemId } = input
    if (turnItemId === null) {
      return
    }
    const clientMessageId = hivewardShutdownRowClientMessageId(
      input.sessionId,
      input.fence,
      input.generation
    )
    const items = input.journal.snapshot().items
    const written = items.some((item) => {
      const identity = parseAgentJournalItemKey(item.itemId)
      return identity?.provider === 'hiveward' && identity.clientMessageId === clientMessageId
    })
    if (written || !cutByNobody(items.find((item) => item.itemId === turnItemId))) {
      return
    }
    await input.journal.appendItem(
      { provider: 'hiveward', clientMessageId },
      hivewardStopRowBody(input.failureTextContext, input.trigger),
      { fence: input.rowFence, turnScope: { kind: 'turn', turnItemId } }
    )
  } catch (error) {
    input.logger.warn('recording why a quit cut a reply failed', {
      scope: 'shutdown-cut-row',
      sessionId: input.sessionId,
      error
    })
  }
}
