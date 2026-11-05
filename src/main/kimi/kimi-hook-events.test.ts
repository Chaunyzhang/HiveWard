import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from '../../shared/agent-hook-listener/listener-state'
import { normalizeKimiEvent } from '../../shared/agent-hook-listener/providers/kimi-events'

const PANE_KEY = 'tab-1:leaf-1'
const BASE_PAYLOAD = {
  cwd: '/tmp/kimi-hook-test',
  session_id: 'session-1'
}

describe('Kimi hook status normalization', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function normalize(eventName: string, payload: Record<string, unknown> = {}) {
    return normalizeKimiEvent(state, eventName, '', PANE_KEY, {
      ...BASE_PAYLOAD,
      hook_event_name: eventName,
      ...payload
    })
  }

  it.each(['Stop', 'StopFailure'])('reports %s as done', (eventName) => {
    expect(
      normalize(eventName, {
        stop_hook_active: false,
        error_type: 'APIStatusError',
        error_message: 'local mock failure'
      })
    ).toMatchObject({ state: 'done', agentType: 'kimi' })
  })

  it('reports AskUserQuestion as waiting, then working after its tool result', () => {
    const tool = {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Choose the local test option?',
            header: 'HookTest',
            options: [{ label: 'Option A' }, { label: 'Option B' }],
            multi_select: false
          }
        ]
      },
      tool_call_id: 'call-1'
    }
    expect(normalize('PreToolUse', tool)).toMatchObject({
      state: 'waiting',
      agentType: 'kimi'
    })

    expect(
      normalize('PostToolUse', {
        ...tool,
        tool_output: 'Afk mode, auto-dismissed.'
      })
    ).toMatchObject({ state: 'working', agentType: 'kimi' })
  })

  it('retains read compatibility for legacy PermissionRequest payloads', () => {
    expect(normalize('PermissionRequest', { tool_name: 'Shell' })).toMatchObject({
      state: 'waiting',
      agentType: 'kimi'
    })
  })
})
