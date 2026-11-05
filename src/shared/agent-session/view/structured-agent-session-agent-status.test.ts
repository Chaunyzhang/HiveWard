import { describe, expect, it } from 'vitest'
import type { AgentSessionBackgroundTask } from '../agent-session-background-task-wire'
import {
  agentChildWorkProjectionCandidateFromBackgroundTask,
  projectAgentChildWorkLegacySubagents
} from '../../agent-status-child-work-projection'
import { structuredAgentSessionAgentStatus } from './structured-agent-session-agent-status'

function task(over: Partial<AgentSessionBackgroundTask> = {}): AgentSessionBackgroundTask {
  return { id: 'task-1', kind: 'agent', state: 'working', ...over }
}

describe('structuredAgentSessionAgentStatus', () => {
  // Spinner and child list share a summary; workflows must not claim a child the legacy projection refuses to render.
  it('settles a lead whose only live task is a workflow, with no children to show', () => {
    const backgroundTasks = [task({ id: 'flow-1', kind: 'workflow' })]
    expect(
      structuredAgentSessionAgentStatus({ status: 'idle', childWork: backgroundTasks })
    ).toEqual({
      state: 'done',
      backgroundCommands: 1,
      mainAgent: { state: 'done' }
    })
    expect(
      projectAgentChildWorkLegacySubagents(
        backgroundTasks.map(agentChildWorkProjectionCandidateFromBackgroundTask)
      )
    ).toBeUndefined()
  })

  // Verdicts describe finished turns, not child folding; a cancelled lead with a watch loop still reads monitoring.
  it('carries the turn verdict on the main agent only while the main agent is done', () => {
    expect(
      structuredAgentSessionAgentStatus({ status: 'idle', turnOutcome: 'cancellation' })
    ).toEqual({ state: 'done', mainAgent: { state: 'done', outcome: 'cancellation' } })
    expect(
      structuredAgentSessionAgentStatus({
        status: 'idle',
        turnOutcome: 'cancellation',
        childWork: [task({ kind: 'command' })]
      })
    ).toEqual({
      state: 'done',
      backgroundCommands: 1,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    expect(
      structuredAgentSessionAgentStatus({ status: 'working', turnOutcome: 'failure' })
    ).toEqual({ state: 'working', mainAgent: { state: 'working' } })
  })

  it('keeps live agent work working while counting only live non-agent commands', () => {
    expect(
      structuredAgentSessionAgentStatus({
        status: 'idle',
        childWork: [
          task({ kind: 'agent' }),
          task({ id: 'command-1', kind: 'command' }),
          task({ id: 'monitor-1', kind: 'monitor' }),
          task({ id: 'command-2', kind: 'command', state: 'done' })
        ]
      })
    ).toEqual({
      state: 'working',
      backgroundCommands: 2,
      mainAgent: { state: 'done' }
    })
  })

  it("carries the host's Stopping on a working main agent only", () => {
    expect(structuredAgentSessionAgentStatus({ status: 'working', stopping: true })).toEqual({
      state: 'working',
      mainAgent: { state: 'working', stopping: true }
    })
    expect(structuredAgentSessionAgentStatus({ status: 'idle', stopping: true })).toEqual({
      state: 'done',
      mainAgent: { state: 'done' }
    })
  })
})
