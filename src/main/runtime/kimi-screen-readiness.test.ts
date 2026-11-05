import { describe, expect, it } from 'vitest'
import { finalReplayFrame } from './agent-transcript-replay-test-harness'
import { evaluateAgentStateRules } from './agent-state-rules/agent-state-rules-engine'
import { isQuietReadyScreenBody } from './terminal-wait-detection'

describe('Kimi captured startup screens', () => {
  it.each(['kimi-1-50-ready', 'kimi-2-3-1-ready'])(
    'recognizes %s without a title or hook and refuses drafts and busy screens',
    async (name) => {
      const { ruledScreenLines, waitText } = await finalReplayFrame(name, 100, 30)
      const verdict = (lines: string[]) =>
        evaluateAgentStateRules('kimi', { readScreenLines: () => lines })
      expect(verdict(ruledScreenLines), JSON.stringify(ruledScreenLines)).toMatchObject({
        state: 'idle',
        strength: 'strong',
        requiresQuiet: name === 'kimi-2-3-1-ready'
      })
      expect(isQuietReadyScreenBody(waitText, 'kimi', () => ruledScreenLines)).toBe(
        name === 'kimi-2-3-1-ready'
      )
      const draft =
        name === 'kimi-1-50-ready'
          ? [...ruledScreenLines, 'unsent task']
          : ruledScreenLines.map((line) => line.replace('│ > ', '│ > unsent task'))
      expect(verdict(draft)?.state).toBe('hold')
      expect(verdict(['⠋ Thinking', ...ruledScreenLines])?.state).toBe('hold')
    }
  )

  it('does not admit the real 2.3.1 trust dialog even with an idle title', async () => {
    const { ruledScreenLines, waitText } = await finalReplayFrame('kimi-2-3-1-trust', 100, 30)
    expect(
      evaluateAgentStateRules('kimi', {
        readScreenLines: () => ruledScreenLines,
        readTitleStatus: () => 'idle'
      })
    ).toMatchObject({ state: 'hold' })
    expect(isQuietReadyScreenBody(waitText, 'kimi', () => ruledScreenLines)).toBe(false)
  })
})
