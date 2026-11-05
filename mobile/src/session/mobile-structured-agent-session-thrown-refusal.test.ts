import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  agentSessionReadFailureRefusal,
  agentSessionReadFailureText,
  callAgentSession,
  requestStructuredAgentSessionMutation
} from './mobile-structured-agent-session-rpc'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'

// Model mapRuntimeError: bare-code message with refusal reason in data.
const THROWN_JOURNAL_REFUSAL = {
  code: 'runtime_error',
  message: 'agent_session_journal_unreadable',
  data: {
    refusal: {
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    }
  }
}

function refusingClient(): RpcClient {
  const sendRequest = async (): Promise<RpcResponse> => ({
    id: 'req-1',
    ok: false,
    error: THROWN_JOURNAL_REFUSAL
  })
  return stubRpcClient({ sendRequest })
}

describe('a refusal the host threw', () => {
  it("reads a chat's history failure in the refusal's words, from a stream or a request", async () => {
    const words = 'Unable to load this chat.'
    expect(
      agentSessionReadFailureText({
        type: 'error',
        message: THROWN_JOURNAL_REFUSAL.message,
        error: THROWN_JOURNAL_REFUSAL
      })
    ).toBe(words)
    const thrown = await callAgentSession(refusingClient(), 'agentSession.history', {}).catch(
      (error: unknown) => error
    )
    expect(agentSessionReadFailureText(thrown)).toBe(words)
    expect(agentSessionReadFailureText({ type: 'error', message: 'Connection interrupted' })).toBe(
      'Connection interrupted'
    )
    expect(
      agentSessionReadFailureRefusal({
        type: 'error',
        message: THROWN_JOURNAL_REFUSAL.message,
        error: THROWN_JOURNAL_REFUSAL
      })
    ).toEqual(THROWN_JOURNAL_REFUSAL.data.refusal)
    expect(agentSessionReadFailureRefusal(thrown)).toEqual(THROWN_JOURNAL_REFUSAL.data.refusal)
    expect(
      agentSessionReadFailureRefusal({ type: 'error', message: 'Connection interrupted' })
    ).toBeUndefined()
  })

  it("fails a write with the refusal's words, not as unconfirmed", async () => {
    const result = await requestStructuredAgentSessionMutation({
      client: refusingClient(),
      method: 'agentSession.cancel',
      fingerprintMethod: 'agentSession.cancel',
      sessionId: 'session-1',
      expectedRuntimeFence: 3,
      fields: { turnId: 'turn-1' },
      clientOperationId: `1900000000000-${'c'.repeat(32)}`
    })

    expect(result).toEqual({
      status: 'failed',
      message: "Unable to load this chat. The agent wasn't stopped."
    })
  })
})

describe('a write refused on a journal a newer HiveWard wrote', () => {
  const newerHiveWardClient = (): RpcClient => {
    const sendRequest = async (): Promise<RpcResponse> => ({
      id: 'req-1',
      ok: true,
      result: {
        ok: false,
        refusal: {
          code: 'agent_session_journal_unreadable',
          message: 'Chats were saved by a newer HiveWard. Update HiveWard to keep using them.',
          details: { reason: 'journalWrittenByNewerHiveWard' }
        }
      }
    })
    return stubRpcClient({ sendRequest })
  }

  it.each([
    [
      'agentSession.send',
      { body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] } },
      'Chats were saved by a newer HiveWard. Your message was not sent. Update HiveWard to keep using them.'
    ],
    [
      'agentSession.cancel',
      { turnId: 'turn-1' },
      "Chats were saved by a newer HiveWard. The agent wasn't stopped. Update HiveWard to keep using them."
    ]
  ] as const)('says to update HiveWard for %s', async (method, fields, message) => {
    const result = await requestStructuredAgentSessionMutation({
      client: newerHiveWardClient(),
      method,
      fingerprintMethod: method,
      sessionId: 'session-1',
      expectedRuntimeFence: 3,
      fields,
      clientOperationId: `1900000000000-${'d'.repeat(32)}`
    })

    expect(result).toEqual({
      status: 'refused',
      code: 'agent_session_journal_unreadable',
      message
    })
  })
})
