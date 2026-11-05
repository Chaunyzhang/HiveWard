import { describe, expect, it } from 'vitest'
import { agentStatus } from './hiveward-format'

describe('agentStatus', () => {
  it('shows a seat whose terminal was closed as offline, not failed', () => {
    expect(agentStatus({ state: 'offline', terminal: null })).toBe('offline')
    expect(agentStatus({ state: 'offline', liveness: 'unverifiable' })).toBe(
      'offline'
    )
  })

  it('shows a desktop session seat by its transcript, not as failed', () => {
    expect(
      agentStatus({ state: 'idle', liveness: 'unverifiable', session: true })
    ).toBe('idle')
    expect(
      agentStatus({ state: 'working', liveness: 'unverifiable', session: true })
    ).toBe('working')
  })

  it('still shows an engine error as failed', () => {
    expect(agentStatus({ state: 'failed', terminal: null })).toBe('failed')
  })
})
