import test from 'node:test'
import assert from 'node:assert/strict'
import { timelineEventsFromSources } from './timeline-projection.mjs'

const empty = { gates: [], workers: [], tasks: [], decisionMessages: [], dispatches: [] }
const dispatch = {
  id: 'dsp-1',
  handle: 'term-1',
  project: '/project',
  agent: 'codex',
  prompt: 'Build the feature',
  by: { kind: 'cli', id: 'test', label: 'Test', cwd: '/project' },
  at: '2026-01-01T00:00:00.000Z'
}

test('a fast dispatch transition still records observed work without inventing a missing-terminal start', () => {
  const completed = timelineEventsFromSources({
    ...empty,
    dispatches: [
      {
        dispatch: {
          ...dispatch,
          status: 'completed',
          agentObserved: true,
          agentObservedAt: '2026-01-01T00:00:01.000Z',
          updatedAt: '2026-01-01T00:00:02.000Z'
        }
      }
    ]
  })
  assert.equal(
    completed.find((event) => event.id === 'dispatch:dsp-1:started')?.ts,
    '2026-01-01T00:00:01.000Z'
  )
  const failed = timelineEventsFromSources({
    ...empty,
    dispatches: [{ dispatch: { ...dispatch, status: 'failed', updatedAt: dispatch.at } }]
  })
  assert.equal(
    failed.some((event) => event.id === 'dispatch:dsp-1:started'),
    false
  )
})

test('every worker_done message is projected, not only the first report for a task', () => {
  const reports = [
    {
      id: 'msg-1',
      subject: 'First attempt',
      body: 'First summary',
      created_at: '2026-01-01T00:00:02.000Z',
      from_handle: 'term-1'
    },
    {
      id: 'msg-2',
      subject: 'Retry complete',
      body: 'Retry summary',
      created_at: '2026-01-01T00:00:03.000Z',
      from_handle: 'term-2'
    }
  ]
  const events = timelineEventsFromSources({
    ...empty,
    tasks: [
      {
        task: {
          id: 'task-1',
          status: 'completed',
          created_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:00:03.000Z'
        },
        workerReports: reports,
        business: { id: 'shop', workspacePath: '/project' },
        title: 'Feature'
      }
    ]
  })
  assert.deepEqual(
    events.filter((event) => event.id.startsWith('worker-report:')).map((event) => event.id),
    ['worker-report:msg-1', 'worker-report:msg-2']
  )
  assert.equal(events.find((event) => event.id === 'worker-report:msg-2').detail, 'Retry summary')
})
