import { containsPath } from './workspace-path.mjs'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './data-dir.mjs'

const KEEP = 5000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const AGENT_STATES = new Set(['done', 'waiting', 'blocked'])

const badRequest = (message) =>
  Object.assign(new Error(message), { status: 400, code: 'bad_request' })

function iso(value = Date.now()) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Invalid timestamp')
  }
  return date.toISOString()
}

function readJson(name, fallback) {
  try {
    return JSON.parse(readFileSync(join(dataDir(), name), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback
    }
    throw error
  }
}

function saveJson(name, value) {
  const dir = dataDir()
  const file = join(dir, name)
  const temp = `${file}.${process.pid}.tmp`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, file)
}

function compareDescending(a, b) {
  const byTime = Date.parse(b.ts) - Date.parse(a.ts)
  if (byTime) {
    return byTime
  }
  return a.id === b.id ? 0 : a.id > b.id ? -1 : 1
}

let cachedDir
let cachedEvents
let cachedDescending
function timelineRows() {
  const dir = dataDir()
  if (cachedDir !== dir || !cachedEvents) {
    cachedDir = dir
    cachedEvents = readJson('timeline.json', [])
    cachedDescending = undefined
  }
  return cachedEvents
}

function descendingTimeline() {
  timelineRows()
  cachedDescending ??= [...cachedEvents].sort(compareDescending)
  return cachedDescending
}

function encodeCursor(event, businessId, projectId) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      ts: event.ts,
      id: event.id,
      businessId: businessId ?? null,
      projectId: projectId ?? null
    })
  ).toString('base64url')
}

function decodeCursor(cursor, businessId, projectId) {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error('invalid')
    }
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    if (Buffer.from(raw).toString('base64url') !== cursor) {
      throw new Error('invalid')
    }
    const value = JSON.parse(raw)
    if (
      value?.v !== 1 ||
      typeof value.ts !== 'string' ||
      Number.isNaN(Date.parse(value.ts)) ||
      typeof value.id !== 'string' ||
      !value.id ||
      value.businessId !== (businessId ?? null) ||
      (value.projectId ?? null) !== (projectId ?? null)
    ) {
      throw new Error('invalid')
    }
    return value
  } catch {
    throw badRequest('Invalid timeline cursor')
  }
}

function pageLimit(value) {
  if (value === undefined) {
    return DEFAULT_LIMIT
  }
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') {
    throw badRequest('Invalid timeline limit')
  }
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest('Invalid timeline limit')
  }
  return limit
}

export function appendTimelineEvents(eventOrArray) {
  const incoming = Array.isArray(eventOrArray) ? eventOrArray : [eventOrArray]
  const rows = timelineRows()
  const ids = new Set(rows.map((event) => event.id))
  const added = []
  for (const event of incoming) {
    if (
      !event ||
      typeof event.id !== 'string' ||
      !event.id ||
      typeof event.ts !== 'string' ||
      Number.isNaN(Date.parse(event.ts))
    ) {
      throw badRequest('Timeline events need an id and valid ts')
    }
    if (!ids.has(event.id)) {
      ids.add(event.id)
      rows.push(event)
      added.push(event)
    }
  }
  if (added.length) {
    rows.sort(
      (a, b) => Date.parse(a.ts) - Date.parse(b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    const retained = rows.slice(-KEEP)
    saveJson('timeline.json', retained)
    cachedEvents = retained
    cachedDescending = undefined
  }
  return added
}

export function listTimeline({ businessId, projectId, cursor, limit } = {}) {
  const size = pageLimit(limit)
  const business = businessId === '' ? undefined : businessId
  const filtered = descendingTimeline().filter(
    (event) =>
      (business === undefined || event.businessId === business) &&
      (!projectId || event.projectId === projectId)
  )
  const after =
    cursor === undefined || cursor === null || cursor === ''
      ? undefined
      : decodeCursor(cursor, business, projectId)
  const remaining = after
    ? filtered.filter((event) => compareDescending(event, after) > 0)
    : filtered
  const items = remaining.slice(0, size)
  return {
    items,
    nextCursor: remaining.length > size ? encodeCursor(items.at(-1), business, projectId) : null
  }
}

export function recentTimelineEvents(businessId, limit = 20) {
  return listTimeline({ businessId, limit }).items
}

export function latestTimelineEvent(businessId) {
  return recentTimelineEvents(businessId, 1)[0]
}

const rows = (value, key) =>
  Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : []

function businessForPath(path, businesses) {
  if (!path) {
    return undefined
  }
  const candidates = rows(businesses, 'businesses').filter((business) => {
    const root = business.workspacePath ?? business.path
    if (!root) {
      return false
    }
    return containsPath(root, path)
  })
  return candidates.sort(
    (a, b) => (b.workspacePath ?? b.path ?? '').length - (a.workspacePath ?? a.path ?? '').length
  )[0]
}

function terminalSnapshot(terminal, businesses) {
  const identity = terminal.incarnationId || terminal.ptyId || terminal.handle
  if (typeof identity !== 'string' || !identity) {
    return null
  }
  const path = terminal.worktreePath ?? terminal.path
  const businessId = terminal.businessId ?? businessForPath(path, businesses)?.id
  return {
    identity,
    projectId: terminal.projectId,
    handle: terminal.handle,
    title: terminal.title,
    agent: terminal.agent ?? terminal.agentIdentity,
    path,
    businessId
  }
}

function terminalEvent(action, terminal, ts) {
  const label = terminal.title || terminal.agent || terminal.handle || terminal.identity
  return {
    id: `terminal:${action}:${terminal.identity}:${ts}`,
    ts,
    ...(terminal.businessId ? { businessId: terminal.businessId } : {}),
    projectId: terminal.projectId,
    kind: 'system',
    title: `${action === 'opened' ? '新开' : '关闭'}终端：${label}`,
    ...(terminal.agent ? { agent: terminal.agent } : {}),
    ...(terminal.handle ? { terminal: terminal.handle } : {}),
    ...(terminal.path ? { path: terminal.path } : {})
  }
}

export function recordTerminalSnapshot(terminals, businesses, now) {
  const ts = iso(now)
  const previous = readJson('timeline-terminals.json', null)
  const current = rows(terminals, 'terminals')
    .map((terminal) => terminalSnapshot(terminal, businesses))
    .filter(Boolean)
  if (previous === null) {
    saveJson('timeline-terminals.json', current)
    return []
  }
  const known = new Map(previous.map((terminal) => [terminal.identity, terminal]))
  const present = new Map(current.map((terminal) => [terminal.identity, terminal]))
  const events = [
    ...current
      .filter((terminal) => !known.has(terminal.identity))
      .map((terminal) => terminalEvent('opened', terminal, ts)),
    ...previous
      .filter((terminal) => !present.has(terminal.identity))
      .map((terminal) => terminalEvent('closed', terminal, ts))
  ]
  const added = appendTimelineEvents(events)
  if (JSON.stringify(previous) !== JSON.stringify(current)) {
    saveJson('timeline-terminals.json', current)
  }
  return added
}

function notificationEvent(notification, epoch, context) {
  const terminal = context.terminals.find(
    (candidate) => candidate.paneKey && candidate.paneKey === notification.paneKey
  )
  const worktreeId = notification.worktreeId ?? terminal?.worktreeId
  const worktree = context.worktrees.find(
    (candidate) => candidate.id === worktreeId || candidate.worktreeId === worktreeId
  )
  const path = worktree?.path ?? worktree?.worktreePath ?? terminal?.worktreePath ?? terminal?.path
  const businessId = businessForPath(path, context.businesses)?.id
  const seq = notification.notificationSeq
  return {
    id: `notification:${notification.notificationEpoch ?? epoch ?? 'unknown'}:${seq}`,
    ts: iso(notification.emittedAt ?? notification.createdAt ?? Date.now()),
    ...(businessId ? { businessId } : {}),
    projectId: terminal?.projectId,
    kind: 'worker',
    title: `${notification.agentState === 'done' ? 'Agent 一轮干完' : 'Agent 等待确认'}：${notification.title ?? notification.body ?? ''}`,
    ...(typeof notification.body === 'string' ? { detail: notification.body } : {}),
    ...(terminal?.agentIdentity ? { agent: terminal.agentIdentity } : {}),
    ...(terminal?.handle ? { terminal: terminal.handle } : {}),
    ...(path ? { path } : {})
  }
}

export async function captureAgentNotifications({ rpc, terminals, worktrees, businesses }) {
  const previous = { lastSeenSeq: 0, ...readJson('timeline-notifications.json', {}) }
  const response = await rpc('notifications.getMissedSince', {
    lastSeenSeq: previous.lastSeenSeq,
    epoch: previous.epoch,
    includeDesktopSuppressed: true
  })
  if (response == null) {
    return []
  }
  const notifications = Array.isArray(response.notifications) ? response.notifications : []
  const epoch = response.epoch ?? notifications.at(-1)?.notificationEpoch ?? previous.epoch
  const sameEpoch = epoch === previous.epoch
  const lastSeenSeq = notifications.reduce(
    (latest, notification) =>
      Number.isInteger(notification.notificationSeq) && notification.notificationSeq >= 0
        ? Math.max(latest, notification.notificationSeq)
        : latest,
    sameEpoch ? previous.lastSeenSeq : 0
  )
  const context = {
    terminals: rows(terminals, 'terminals'),
    worktrees: rows(worktrees, 'worktrees'),
    businesses: rows(businesses, 'businesses')
  }
  const events = notifications
    .filter(
      (notification) =>
        notification.type === 'notification' &&
        notification.source === 'agent-task-complete' &&
        AGENT_STATES.has(notification.agentState) &&
        Number.isInteger(notification.notificationSeq) &&
        notification.notificationSeq >= 0
    )
    .map((notification) => notificationEvent(notification, epoch, context))
  const added = appendTimelineEvents(events)
  if (previous.epoch !== epoch || previous.lastSeenSeq !== lastSeenSeq) {
    saveJson('timeline-notifications.json', {
      ...(epoch ? { epoch } : {}),
      lastSeenSeq
    })
  }
  return added
}
