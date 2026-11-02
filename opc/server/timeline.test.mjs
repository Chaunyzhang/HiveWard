import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function tempDataDir(t) {
  const root = mkdtempSync(join(tmpdir(), 'opc-timeline-'))
  const previous = process.env.OPC_DATA_DIR
  process.env.OPC_DATA_DIR = root
  t.after(() => {
    if (previous === undefined) {
      delete process.env.OPC_DATA_DIR
    } else {
      process.env.OPC_DATA_DIR = previous
    }
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

const event = (id, ts, businessId) => ({
  id,
  ts,
  ...(businessId ? { businessId } : {}),
  kind: 'system',
  title: id
})

const isBadRequest = (error) =>
  error instanceof Error && error.status === 400 && error.code === 'bad_request'

test('append dedupes ids and persists events across module restarts', async (t) => {
  const root = tempDataDir(t)
  const timeline = await import('./timeline.mjs')
  const first = event('first', '2026-01-01T00:00:00.000Z')
  const second = event('second', '2026-01-02T00:00:00.000Z', 'shop')
  assert.deepEqual(timeline.appendTimelineEvents(first), [first])
  assert.deepEqual(
    timeline.appendTimelineEvents([{ ...first, title: 'duplicate' }, second, second]),
    [second]
  )
  assert.equal(statSync(join(root, 'timeline.json')).mode & 0o777, 0o600)
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith('.tmp')),
    []
  )

  const restarted = await import('./timeline.mjs?restart=append')
  assert.deepEqual(
    restarted.listTimeline().items.map((item) => item.id),
    ['second', 'first']
  )
  assert.deepEqual(restarted.recentTimelineEvents('shop'), [second])
  assert.deepEqual(restarted.latestTimelineEvent(), second)
  assert.equal(restarted.latestTimelineEvent('missing'), undefined)
})

test('retention caps stored events and list limits stay bounded', async (t) => {
  const root = tempDataDir(t)
  const timeline = await import('./timeline.mjs')
  const events = Array.from({ length: 5005 }, (_, index) =>
    event(
      `event-${String(index).padStart(6, '0')}`,
      new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString()
    )
  )
  assert.equal(timeline.appendTimelineEvents(events).length, 5005)
  const stored = JSON.parse(readFileSync(join(root, 'timeline.json'), 'utf8'))
  assert.equal(stored.length, 5000)
  assert.equal(stored[0].id, 'event-000005')
  assert.equal(timeline.listTimeline().items.length, 50)
  assert.equal(timeline.listTimeline({ limit: 100 }).items.length, 100)
  assert.equal(timeline.recentTimelineEvents().length, 20)
  assert.equal(timeline.latestTimelineEvent().id, 'event-005004')
})

test('keyset pages are descending, stable for equal timestamps, and filter first', async (t) => {
  tempDataDir(t)
  const timeline = await import('./timeline.mjs')
  const early = '2026-02-01T00:00:00.000Z'
  const equal = '2026-02-02T00:00:00.000Z'
  const late = '2026-02-03T00:00:00.000Z'
  timeline.appendTimelineEvents([
    event('a', equal, 'shop'),
    event('old', early, 'shop'),
    event('other', '2026-02-04T00:00:00.000Z', 'finance'),
    event('c', equal, 'shop'),
    event('new', late, 'shop'),
    event('b', equal, 'shop')
  ])

  const first = timeline.listTimeline({ businessId: 'shop', limit: '2' })
  assert.deepEqual(
    first.items.map((item) => item.id),
    ['new', 'c']
  )
  assert.ok(first.nextCursor)
  const second = timeline.listTimeline({
    businessId: 'shop',
    cursor: first.nextCursor,
    limit: 2
  })
  assert.deepEqual(
    second.items.map((item) => item.id),
    ['b', 'a']
  )
  const third = timeline.listTimeline({
    businessId: 'shop',
    cursor: second.nextCursor,
    limit: 2
  })
  assert.deepEqual(
    third.items.map((item) => item.id),
    ['old']
  )
  assert.equal(third.nextCursor, null)
  assert.deepEqual(
    timeline.listTimeline().items.map((item) => item.id),
    ['other', 'new', 'c', 'b', 'a', 'old']
  )

  for (const cursor of ['not-base64!', Buffer.from('{}').toString('base64url'), 42]) {
    assert.throws(() => timeline.listTimeline({ cursor }), isBadRequest)
  }
  assert.throws(
    () => timeline.listTimeline({ businessId: 'finance', cursor: first.nextCursor }),
    isBadRequest
  )
  for (const limit of [0, -1, 101, 1.5, 'abc', '', null, Number.NaN, Infinity, {}]) {
    assert.throws(() => timeline.listTimeline({ limit }), isBadRequest)
  }
})

test('terminal snapshots emit open, observed close, and a distinct reopen', async (t) => {
  const root = tempDataDir(t)
  const timeline = await import('./timeline.mjs')
  const terminal = {
    handle: 'term-1',
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    worktreePath: '/project',
    title: 'Codex worker',
    agentIdentity: 'codex'
  }
  const businesses = [{ id: 'shop', workspacePath: '/project' }]
  const openedAt = '2026-03-01T10:00:00.000Z'
  assert.deepEqual(timeline.recordTerminalSnapshot([], businesses, openedAt), [])
  const opened = timeline.recordTerminalSnapshot([terminal], businesses, openedAt)
  assert.equal(opened.length, 1)
  assert.match(opened[0].id, /inc-1/)
  assert.doesNotMatch(opened[0].id, /pty-1/)
  assert.deepEqual(
    {
      ts: opened[0].ts,
      businessId: opened[0].businessId,
      path: opened[0].path,
      terminal: opened[0].terminal,
      agent: opened[0].agent
    },
    { ts: openedAt, businessId: 'shop', path: '/project', terminal: 'term-1', agent: 'codex' }
  )
  assert.match(opened[0].title, /新开/)
  assert.deepEqual(timeline.recordTerminalSnapshot([terminal], businesses), [])

  const restarted = await import('./timeline.mjs?restart=terminals')
  assert.deepEqual(restarted.recordTerminalSnapshot([terminal], businesses), [])
  const closedAt = '2026-03-01T10:01:00.000Z'
  const closed = restarted.recordTerminalSnapshot([], businesses, closedAt)
  assert.equal(closed.length, 1)
  assert.match(closed[0].title, /关闭/)
  assert.equal(closed[0].ts, closedAt)
  assert.equal(closed[0].terminal, 'term-1')
  assert.equal(closed[0].businessId, 'shop')
  assert.deepEqual(restarted.recordTerminalSnapshot([], businesses), [])

  const reopenedAt = '2026-03-01T10:02:00.000Z'
  const reopened = restarted.recordTerminalSnapshot([terminal], businesses, reopenedAt)
  assert.equal(reopened.length, 1)
  assert.equal(reopened[0].ts, reopenedAt)
  assert.notEqual(reopened[0].id, opened[0].id)
  assert.equal(restarted.listTimeline().items.length, 3)
  assert.equal(statSync(join(root, 'timeline-terminals.json')).mode & 0o777, 0o600)
})

test('the first terminal snapshot establishes a baseline without fake opening events', async (t) => {
  tempDataDir(t)
  const timeline = await import('./timeline.mjs')
  const terminal = { handle: 'existing', incarnationId: 'existing-inc', worktreePath: '/project' }
  assert.deepEqual(timeline.recordTerminalSnapshot([terminal], []), [])
  assert.deepEqual(timeline.listTimeline().items, [])
})

test('notification catch-up maps, dedupes, advances filtered seqs, and changes epoch', async (t) => {
  const root = tempDataDir(t)
  const timeline = await import('./timeline.mjs')
  const terminals = [{ paneKey: 'tab:leaf', handle: 'term-1', agentIdentity: 'codex' }]
  const worktrees = [{ id: 'repo::/project', path: '/project' }]
  const businesses = [{ id: 'shop', workspacePath: '/project' }]
  const base = {
    type: 'notification',
    source: 'agent-task-complete',
    worktreeId: 'repo::/project',
    paneKey: 'tab:leaf',
    notificationEpoch: 'epoch-1',
    emittedAt: Date.UTC(2026, 3, 1, 12)
  }
  let response = {
    epoch: 'epoch-1',
    notifications: [
      {
        ...base,
        notificationSeq: 1,
        agentState: 'done',
        title: 'Finished',
        body: 'All checks pass'
      },
      { ...base, notificationSeq: 2, agentState: 'waiting', title: 'Waiting', body: 'Need input' },
      { ...base, notificationSeq: 3, agentState: 'working', title: 'Working' },
      { ...base, notificationSeq: 4, agentState: 'blocked', title: 'Blocked', body: 'Choose one' },
      { ...base, notificationSeq: 5, source: 'terminal-bell', agentState: 'done' },
      { ...base, notificationSeq: 6, type: 'dismiss', agentState: 'done' }
    ]
  }
  const calls = []
  const rpc = async (method, params) => {
    calls.push({ method, params })
    return response
  }
  const context = { rpc, terminals, worktrees, businesses }
  const added = await timeline.captureAgentNotifications(context)
  assert.deepEqual(
    added.map((item) => item.id),
    ['notification:epoch-1:1', 'notification:epoch-1:2', 'notification:epoch-1:4']
  )
  assert.deepEqual(
    {
      ts: added[0].ts,
      businessId: added[0].businessId,
      path: added[0].path,
      terminal: added[0].terminal,
      agent: added[0].agent,
      title: added[0].title,
      detail: added[0].detail,
      kind: added[0].kind
    },
    {
      ts: '2026-04-01T12:00:00.000Z',
      businessId: 'shop',
      path: '/project',
      terminal: 'term-1',
      agent: 'codex',
      title: 'Agent 一轮干完：Finished',
      detail: 'All checks pass',
      kind: 'worker'
    }
  )
  assert.deepEqual(calls[0], {
    method: 'notifications.getMissedSince',
    params: { lastSeenSeq: 0, epoch: undefined, includeDesktopSuppressed: true }
  })

  assert.deepEqual(await timeline.captureAgentNotifications(context), [])
  assert.equal(timeline.listTimeline().items.length, 3)
  assert.equal(calls[1].params.lastSeenSeq, 6)
  assert.equal(calls[1].params.epoch, 'epoch-1')

  response = null
  assert.deepEqual(await timeline.captureAgentNotifications(context), [])
  response = {
    epoch: 'epoch-2',
    notifications: [
      {
        ...base,
        notificationEpoch: 'epoch-2',
        notificationSeq: 1,
        agentState: 'blocked',
        title: 'New runtime',
        body: 'Approval needed'
      }
    ]
  }
  const nextEpoch = await timeline.captureAgentNotifications(context)
  assert.deepEqual(
    nextEpoch.map((item) => item.id),
    ['notification:epoch-2:1']
  )
  assert.deepEqual(calls[3].params, {
    lastSeenSeq: 6,
    epoch: 'epoch-1',
    includeDesktopSuppressed: true
  })
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'timeline-notifications.json'), 'utf8')), {
    epoch: 'epoch-2',
    lastSeenSeq: 1
  })
  assert.equal(statSync(join(root, 'timeline-notifications.json')).mode & 0o777, 0o600)

  const restarted = await import('./timeline.mjs?restart=notifications')
  response = null
  assert.deepEqual(await restarted.captureAgentNotifications(context), [])
  assert.deepEqual(calls[4].params, {
    lastSeenSeq: 1,
    epoch: 'epoch-2',
    includeDesktopSuppressed: true
  })
  assert.equal(restarted.listTimeline().items.length, 4)
})
