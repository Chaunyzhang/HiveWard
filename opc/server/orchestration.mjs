import {
  businessProjects,
  migrateProjects,
  projectSummaries,
  projectOf,
  within
} from './business-projects.mjs'
import { updateBusiness, canonicalPath, apiError } from './business.mjs'
import { rpc, optionalRpc, iso, json } from './api-runtime.mjs'
import { observeTerminal } from './business-terminals.mjs'
import { syncedBusinesses } from './projects.mjs'
import { dispatches, observeDispatches, dispatchTask, dispatchDecision } from './dispatches.mjs'
import { businessIdentity } from './project-identity.mjs'
import {
  appendTimelineEvents,
  captureAgentNotifications,
  latestTimelineEvent,
  recentTimelineEvents,
  recordTerminalSnapshot
} from './timeline.mjs'
import { timelineEventsFromSources } from './timeline-projection.mjs'
import { seatOccupantId, summarizeSeat } from './seat-occupants.mjs'

export const OWNER = 'opc-owner' // OPC's explicit message address; never impersonate a coordinator.
// Set this to an actual OPC HQ run:<id> or terminal handle when a boss mailbox exists.
export const OWNER_MAILBOX = process.env.OPC_OWNER_MAILBOX
const TASK_STATUSES = new Set(['pending', 'ready', 'dispatched', 'blocked', 'completed', 'failed'])
let cache,
  inFlight,
  version = 0
export function invalidate() {
  cache = undefined
  version++
}
export async function snapshot() {
  if (cache && Date.now() - cache.at < 2500) {
    return cache.value
  }
  if (inFlight) {
    return inFlight
  }
  const generation = version
  inFlight = collect()
    .then((value) => {
      if (version === generation) {
        cache = { at: Date.now(), value }
      }
      return value
    })
    .finally(() => {
      inFlight = undefined
    })
  return inFlight
}
async function pages(method, key, params = {}) {
  const rows = []
  let cursor
  do {
    const response = await rpc(method, { ...params, cursor })
    rows.push(...response[key])
    cursor = response.nextCursor ?? response.page?.nextCursor
  } while (cursor)
  return rows
}
async function collect() {
  const timeline = { gates: [], workers: [], tasks: [], decisionMessages: [], dispatches: [] }
  const { rows: registrations, identities } = await syncedBusinesses()
  const [status, listed, worktrees, runs, inbox] = await Promise.all([
    rpc('status.get'),
    rpc('terminal.list'),
    optionalRpc('worktree.list'),
    pages('orchestration.runList', 'runs'),
    // SQLite LIMIT -1 means all history; no cursor is exposed by inbox.
    rpc('orchestration.inbox', { limit: -1 })
  ])
  const paths = new Set(registrations.map((b) => canonicalPath(b.workspacePath)))
  const handles = new Set(registrations.map((b) => b.leaderTerminal).filter(Boolean))
  const terminals = await Promise.all(
    listed.terminals
      .filter(
        (t) => [...paths].some((path) => within(t.worktreePath, path)) || handles.has(t.handle)
      )
      .map(observeTerminal)
  )
  const details = []
  const assignments = dispatches()
  for (let business of registrations) {
    const assignment = assignments.findLast(
      (d) =>
        d.role === 'leader' &&
        canonicalPath(d.project) === canonicalPath(business.workspacePath) &&
        terminals.some((t) => t.handle === d.handle && t.agent)
    )
    if (assignment && assignment.handle !== business.leaderTerminal) {
      const previousRuns = runs
        .filter((r) => r.coordinator_handle === business.leaderTerminal)
        .map((r) => r.id)
      business = updateBusiness(business.id, {
        leaderTerminal: assignment.handle,
        leaderStartedAt: terminals.find((t) => t.handle === assignment.handle)?.startedAt,
        runIds: [...new Set([...(business.runIds ?? []), ...previousRuns])]
      })
    }
    if (!business.leaderTerminal) {
      const leader = terminals.find(
        (t) =>
          canonicalPath(t.worktreePath) === canonicalPath(business.workspacePath) &&
          t.handle !== business.ceo?.terminal &&
          t.agent === business.leaderAgent
      )
      if (leader) {
        business = updateBusiness(business.id, {
          leaderTerminal: leader.handle,
          leaderStartedAt: leader.startedAt
        })
      }
    }
    migrateProjects(business, terminals, assignments)
    const projectLeaders = businessProjects(business.id)
      .map((p) => p.leader?.terminal)
      .filter(Boolean)
    const leaderTerminal = terminals.find((t) => t.handle === business.leaderTerminal)
    const businessRuns = runs.filter(
      (r) =>
        (business.runIds ?? []).includes(r.id) ||
        (business.leaderTerminal && r.coordinator_handle === business.leaderTerminal) ||
        projectLeaders.includes(r.coordinator_handle)
    )
    const tasks = [],
      workers = [],
      objectives = [],
      decisions = []
    for (const run of businessRuns) {
      const [taskRows, gateRows, fleet] = await Promise.all([
        rpc('orchestration.taskList', { run: run.id }),
        rpc('orchestration.gateList', { run: run.id }),
        pages('orchestration.workerList', 'workers', { run: run.id })
      ])
      const pendingGates = gateRows.gates.filter((g) => g.status === 'pending')
      for (const gate of gateRows.gates) {
        timeline.gates.push({ gate, business })
      }
      const messages = inbox.messages.filter((m) => m.run_id === run.id)
      const runWorkers = await Promise.all(
        fleet.map(async (w) => {
          const shown = await rpc('orchestration.workerShow', { dispatch: w.dispatchId })
          const projection = w.projection ?? w
          const agent = projection.provider?.id ?? shown.worker?.startOptions?.agent ?? ''
          const startedAt = iso(
            shown.worker?.createdAt ?? shown.dispatch?.dispatchedAt ?? shown.dispatch?.createdAt
          )
          timeline.workers.push({ dispatch: w, shown, agent, startedAt, business })
          const heartbeat = messages.find(
            (m) => m.type === 'heartbeat' && json(m.payload, {}).dispatchId === w.dispatchId
          )
          return {
            dispatchId: w.dispatchId,
            taskId: w.taskId,
            agent,
            model: projection.provider?.model ?? undefined,
            liveness: projection.liveness?.verdict ?? 'unverifiable',
            terminalState:
              w.terminalState ??
              w.resource?.terminalState ??
              (shown.terminal ? 'active' : 'release_unknown'),
            startedAt,
            terminal: shown.terminal?.handle ?? undefined,
            path: listed.terminals.find((t) => t.handle === shown.terminal?.handle)?.worktreePath,
            phase: heartbeat ? json(heartbeat.payload, {}).phase : undefined,
            lastHeartbeatAt: heartbeat ? iso(heartbeat.created_at) : undefined
          }
        })
      )
      workers.push(...runWorkers)
      const runTasks = taskRows.tasks.map((t) => {
        if (!TASK_STATUSES.has(t.status)) {
          throw apiError(502, 'orca_invalid_data', `未知任务状态：${t.status}`)
        }
        const worker =
          runWorkers.find((w) => w.dispatchId === t.dispatch_id) ??
          runWorkers.find((w) => w.taskId === t.id)
        const workerReports = messages.filter(
          (m) =>
            m.type === 'worker_done' &&
            json(m.payload, {}).taskId === t.id &&
            (!t.dispatch_id || json(m.payload, {}).dispatchId === t.dispatch_id)
        )
        const done = workerReports[0]
        const payload = done ? json(done.payload, {}) : null
        const report =
          payload && ['succeeded', 'failed'].includes(payload.outcome)
            ? {
                outcome: payload.outcome,
                summary: done.body,
                reportedAt: iso(done.created_at),
                filesModified: payload.filesModified,
                reportPath: payload.reportPath
              }
            : undefined
        const title = t.spec.slice(0, 100)
        timeline.tasks.push({ task: t, worker, done, workerReports, business, title })
        return {
          id: t.id,
          businessId: business.id,
          projectId: businessProjects(business.id).find(
            (p) => p.leader?.terminal === run.coordinator_handle
          )?.id,
          objectiveId: run.id,
          runId: run.id,
          title,
          status: t.status,
          deps: json(t.deps, []),
          assignee: worker
            ? { agent: worker.agent, dispatchId: worker.dispatchId, liveness: worker.liveness }
            : undefined,
          blockedReason:
            t.status === 'blocked'
              ? pendingGates
                  .filter((g) => g.task_id === t.id)
                  .map((g) => g.question)
                  .join('\n') || undefined
              : undefined,
          report,
          updatedAt: iso(t.updated_at ?? t.completed_at ?? done?.created_at ?? t.created_at)
        }
      })
      tasks.push(...runTasks)
      const done = runTasks.filter((t) => t.status === 'completed').length
      objectives.push({
        id: run.id,
        runId: run.id,
        businessId: business.id,
        title: run.objective,
        status:
          runTasks.length && done === runTasks.length
            ? 'done'
            : runTasks.some((t) => t.status === 'failed')
              ? 'failed'
              : 'running',
        progress: { done, total: runTasks.length },
        createdAt: iso(run.created_at)
      })
      decisions.push(
        ...pendingGates.map((g) => ({
          id: g.id,
          businessId: business.id,
          projectId: businessProjects(business.id).find(
            (p) => p.leader?.terminal === run.coordinator_handle
          )?.id,
          objectiveId: run.id,
          source: 'gate',
          question: g.question,
          options: json(g.options, []),
          urgency: 'normal',
          state: 'pending',
          createdAt: iso(g.created_at),
          delivery: messages.some(
            (m) => m.from_handle === OWNER && json(m.payload, {}).gateId === g.id
          )
            ? 'enqueued'
            : undefined
        }))
      )
    }
    const runIds = new Set(businessRuns.map((r) => r.id))
    for (const message of inbox.messages) {
      if (
        !OWNER_MAILBOX ||
        !['escalation', 'question'].includes(message.type) ||
        message.to_handle !== OWNER_MAILBOX
      ) {
        continue
      }
      const payload = json(message.payload, {})
      if (
        !runIds.has(message.run_id) &&
        !runIds.has(payload.runId) &&
        message.from_handle !== business.leaderTerminal
      ) {
        continue
      }
      const reply = inbox.messages.find(
        (m) => m.thread_id === (message.thread_id ?? message.id) && m.from_handle === OWNER
      )
      timeline.decisionMessages.push({ message, reply, business })
      decisions.push({
        id: message.id,
        businessId: business.id,
        objectiveId: runIds.has(message.run_id)
          ? message.run_id
          : runIds.has(payload.runId)
            ? payload.runId
            : undefined,
        source: message.type,
        question: message.subject,
        body: message.body,
        options: Array.isArray(payload.options) ? payload.options : [],
        recommendation: payload.recommendation,
        urgency: message.priority === 'normal' ? 'normal' : 'high',
        state: reply ? 'resolved' : 'pending',
        createdAt: iso(message.created_at),
        resolution: reply ? { choice: reply.body, resolvedAt: iso(reply.created_at) } : undefined
      })
    }

    const assigned = new Set(workers.map((w) => w.terminal))
    for (const t of terminals) {
      if (!within(t.worktreePath, business.workspacePath) || !t.agent || assigned.has(t.handle)) {
        continue
      }
      workers.push({
        dispatchId: `term:${t.handle}`,
        taskId: '',
        agent: t.agent,
        liveness: 'live',
        terminalState: 'active',
        startedAt: t.startedAt,
        terminal: t.handle,
        path: t.worktreePath,
        title: t.title || undefined
      })
    }
    const liveness = !leaderTerminal ? 'exited' : leaderTerminal.agent ? 'live' : 'unverifiable'
    const leader = business.leaderTerminal
      ? {
          id: business.leaderTerminal,
          agent: business.leaderAgent,
          model: business.leaderModel,
          liveness,
          state: liveness === 'live' ? 'live' : 'stale',
          comment:
            worktrees?.worktrees?.find((w) => w.path === business.workspacePath)?.comment ||
            undefined,
          startedAt: leaderTerminal?.agent
            ? leaderTerminal.startedAt
            : (business.leaderStartedAt ?? '')
        }
      : null
    const counts = {
      objectivesRunning: objectives.filter((o) => o.status === 'running').length,
      tasksOpen: tasks.filter((t) => !['completed', 'failed'].includes(t.status)).length,
      tasksDone: tasks.filter((t) => t.status === 'completed').length,
      workersLive: workers.filter(
        (w) =>
          w.liveness === 'live' &&
          !projectLeaders.includes(w.terminal) &&
          w.terminal !== business.ceo?.terminal
      ).length,
      decisionsPending: decisions.filter((d) => d.state === 'pending').length
    }
    const identity = identities.get(business.id) ?? (await businessIdentity(business))
    details.push({
      business: {
        id: business.id,
        name: identity.name,
        nameSource: identity.nameSource,
        logo: identity.logo,
        icon: business.icon,
        status: business.status,
        priority: business.priority,
        workspacePath: business.workspacePath,
        repoId: business.repoId,
        kind: business.kind,
        missing: business.missing,
        leader,
        ceo: null,
        projects: [],
        counts,
        updatedAt: business.updatedAt
      },
      authority: business.authority,
      objectives,
      tasks,
      workers,
      decisions,
      recentEvents: []
    })
  }
  // 派单（hiwd new / tell）也是任务：属于哪块业务（Grok 带的业务 id / Agent 所在目录 / 派单方所在目录）就归哪块，其余单独列
  const sent = await observeDispatches(listed.terminals)
  const orphanTasks = [],
    orphanDecisions = []
  const roots = rootByHandle(sent)
  for (const d of sent) {
    d.projectId = projectOf({ ...d, path: d.project }, businessProjects(), sent)?.id
    const owner = businessOf(roots.get(d.handle) ?? d, details)
    const businessId = owner?.business.id
    // 追加的话（同一终端上没汇报完又补的）不单独算任务，进展已回填到原任务
    if (d.parent) {
      timeline.dispatches.push({ dispatch: d, businessId })
      continue
    }
    const task = dispatchTask(
      d,
      businessId,
      sent.filter((x) => x.parent === d.id)
    )
    if (task.dispatchedBy.kind === 'grok' && owner) {
      task.dispatchedBy.label = `Grok Bot·${owner.business.name}`
    }
    const decision = d.status === 'blocked' ? dispatchDecision(d, businessId) : null
    timeline.dispatches.push({ dispatch: d, businessId, decision })
    if (owner) {
      owner.tasks.push(task)
      if (task.status === 'completed') {
        owner.business.counts.tasksDone++
      } else if (task.status !== 'failed') {
        owner.business.counts.tasksOpen++
      }
      if (decision) {
        owner.decisions.push(decision)
        owner.business.counts.decisionsPending++
      }
    } else {
      orphanTasks.push(task)
      if (decision) {
        orphanDecisions.push(decision)
      }
    }
  }
  const timelineTerminals = listed.terminals.map((t) => ({
    ...t,
    projectId: projectOf({ handle: t.handle, path: t.worktreePath }, businessProjects(), sent)?.id
  }))
  recordTerminalSnapshot(timelineTerminals, registrations)
  await captureAgentNotifications({
    rpc: optionalRpc,
    terminals: timelineTerminals,
    worktrees: worktrees?.worktrees ?? [],
    businesses: registrations
  })
  for (const detail of details) {
    detail.business.projects = projectSummaries(detail.business.id, terminals, sent, detail.workers)
    detail.business.ceo = summarizeSeat(
      registrations.find((row) => row.id === detail.business.id)?.ceo,
      terminals,
      sent
    )
    for (const task of detail.tasks) {
      const worker = detail.workers.find((w) => w.taskId === task.id)
      task.projectId ??= projectOf(
        { handle: worker?.terminal, path: worker?.path },
        detail.business.projects,
        sent
      )?.id
    }
  }
  appendTimelineEvents(
    timelineEventsFromSources(timeline).map((event) => ({
      ...event,
      projectId:
        event.projectId ??
        details.flatMap((d) => d.tasks).find((t) => t.id === event.taskId)?.projectId ??
        projectOf({ handle: event.terminal, path: event.path }, businessProjects(), sent)?.id
    }))
  )
  for (const detail of details) {
    detail.recentEvents = recentTimelineEvents(detail.business.id, 20)
    detail.business.lastEvent = latestTimelineEvent(detail.business.id)
  }
  return {
    health: {
      reachable: true,
      appVersion: status.appVersion,
      runtimeState: status.graphStatus,
      collectedAt: new Date().toISOString()
    },
    details,
    dispatches: sent,
    orphanTasks,
    orphanDecisions
  }
}

const AGENT_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
  opencode: 'opencode',
  'claude-desktop': 'Claude 桌面端'
}
const agentName = (a) => AGENT_NAMES[a] ?? a
// 派活的会话是哪家：Claude 桌面端和终端里的 Claude Code 用不同的 logo
const sessionAgent = (by) =>
  by.kind === 'claude-desktop'
    ? 'claude-desktop'
    : by.kind.startsWith('claude')
      ? 'claude'
      : undefined
// 派单状态 → 架构图节点上的状态
const dispatchState = {
  completed: 'done',
  dispatched: 'working',
  failed: 'failed',
  blocked: 'blocked',
  pending: 'pending'
}

/** 每个终端上的第一条派单：决定这个终端归谁（老板在待办里答复的那几条跟着原派单走） */
function rootByHandle(sent) {
  const roots = new Map()
  for (const d of sent) {
    if (!roots.has(d.handle)) {
      roots.set(d.handle, d)
    }
  }
  return roots
}

/** 派单属于哪块业务：Grok 带的业务 id（OPC_DISPATCHER=grok:<业务id>）→ Agent 所在目录 → 派单方所在目录 */
function businessOf(d, details) {
  const live = details.filter((x) => ['active', 'paused'].includes(x.business.status))
  const id = d.by.kind === 'grok' && /^grok:(.+)$/.exec(d.by.id)?.[1]
  return (
    (d.projectId &&
      live.find(
        (x) =>
          x.business.projects?.some((p) => p.id === d.projectId) ||
          businessProjects(x.business.id).some((p) => p.id === d.projectId)
      )) ||
    (id && live.find((x) => x.business.id === id)) ||
    live.find((x) => within(d.project, x.business.workspacePath)) ||
    live.find((x) => within(d.by.cwd, x.business.workspacePath))
  )
}

function dispatchedWorker(d, parentId, businessId) {
  return {
    id: `dispatch:${d.handle}`,
    kind: 'worker',
    parentId,
    businessId,
    label: d.liveAgent ?? d.agent ?? 'shell',
    agent: d.liveAgent ?? d.agent ?? undefined,
    liveness: 'live',
    terminal: d.handle,
    activity: d.title || d.prompt.split('\n')[0].slice(0, 80),
    state: dispatchState[d.status],
    review: d.review?.state,
    startedAt: d.at,
    finishedAt: d.status === 'completed' ? d.report?.reportedAt : undefined
  }
}

/** 老板卡 / hiwd assign 派给 Leader Agent 时开的、还活着的那个 Agent（这一行的 Leader Agent），按目录找最近的一个 */
function ownerSeat(sent, latest, root) {
  const d = sent.findLast(
    (x) =>
      (x.role === 'leader' || x.by.kind === 'owner') &&
      within(x.project, root) &&
      latest.has(x.handle)
  )
  return d && latest.get(d.handle)
}

// Leader Agent 回完老板的话就是空闲，不算「已完成」
const seatState = (d) =>
  ({ dispatched: 'working', pending: 'pending', blocked: 'blocked' })[d.status] ?? 'idle'
// Orca 编排里的下属：按它手上任务的状态
const workerState = (status) =>
  ({
    completed: 'done',
    failed: 'failed',
    blocked: 'blocked',
    dispatched: 'working',
    pending: 'pending',
    ready: 'pending'
  })[status] ?? 'idle'

const tally = (rows) =>
  `派单 ${rows.filter((d) => d.status === 'completed').length}/${rows.length} 已汇报`

/**
 * 架构图（像并联电路）：每块业务一行——项目 →（这块业务的 Grok Bot ∥ 直连）→ Leader Agent → 下属。
 * Leader Agent 是登记的负责人；没有时，用在这块业务目录里派过活的会话（比如开在 ~/玉石 的 Claude Code）。
 * withProjects：公司级再加上不属于任何业务的项目（比如 ~/opc），每个项目一行，只有直连。
 */
export function topology(details, sent = [], withProjects = true) {
  const nodes = []
  const roots = rootByHandle(sent)
  const latest = new Map()
  for (const d of sent) {
    if (d.alive) {
      latest.set(d.handle, d)
    }
  }
  const firsts = sent.filter((d) => !d.parent && roots.get(d.handle) === d)
  const live = details.filter((x) => ['active', 'paused'].includes(x.business.status))
  const placed = new Set()

  for (const { business: b, workers, tasks } of live) {
    const rootId = `business:${b.id}`
    const c = b.counts
    const projects = b.projects ?? []
    const mine = firsts.filter((d) => businessOf(d, details)?.business.id === b.id)
    const grok = mine.filter((d) => d.by.kind === 'grok')
    nodes.push({
      id: rootId,
      kind: 'business',
      label: b.name,
      project: b.workspacePath,
      businessId: b.id,
      stats: [
        `任务 ${c.tasksDone}/${c.tasksDone + c.tasksOpen}`,
        ...(c.decisionsPending ? [`待决定 ${c.decisionsPending}`] : [])
      ],
      attention:
        c.decisionsPending > 0 ||
        b.ceo?.liveness === 'unverifiable' ||
        projects.some((p) => p.leader?.liveness === 'unverifiable')
    })
    nodes.push({
      id: `grok:${b.id}`,
      kind: 'grok',
      businessId: b.id,
      label: 'Grok Bot',
      agent: 'grokbot',
      activity: grok.length ? tally(grok) : '还没派过活',
      lastSeenAt: grok.at(-1)?.updatedAt ?? grok.at(-1)?.at
    })
    const ceo = b.ceo
    nodes.push({
      id: `ceo:${b.id}`,
      kind: 'ceo',
      parentId: rootId,
      businessId: b.id,
      project: b.workspacePath,
      label: 'CEO Agent',
      sublabel: ceo ? agentName(ceo.agent) : 'CEO 位空着',
      agent: ceo?.agent,
      liveness: ceo?.liveness,
      terminal: ceo?.terminal,
      sessionId: ceo?.occupant?.kind === 'session' ? ceo.occupant.sessionId : undefined,
      state: ceo?.state,
      activity: ceo?.activity,
      startedAt: ceo?.startedAt
    })
    for (const p of projects.filter((p) => p.status === 'active')) {
      const l = p.leader
      nodes.push({
        id: `leader:${p.id}`,
        kind: 'leader',
        parentId: rootId,
        via: `grok:${b.id}`,
        businessId: b.id,
        projectId: p.id,
        project: p.path,
        label: p.name,
        sublabel: l ? agentName(l.agent) : '还没开 Leader Agent',
        agent: l?.agent,
        liveness: l?.liveness,
        terminal: l?.terminal,
        sessionId: l?.occupant?.kind === 'session' ? l.occupant.sessionId : undefined,
        state: l?.state,
        activity: l?.activity,
        startedAt: l?.startedAt
      })
    }
    const parentFor = (p, d) => {
      if (p?.status === 'archived') {
        return null
      }
      if (p) {
        return `leader:${p.id}`
      }
      if (ceo && d?.by.kind !== 'grok' && d?.by.id === seatOccupantId(ceo)) {
        return `ceo:${b.id}`
      }
      const id = `leader:${b.id}:unassigned`
      if (!nodes.some((n) => n.id === id)) {
        nodes.push({ id, kind: 'leader', parentId: rootId, businessId: b.id, label: '未归项目' })
      }
      return id
    }
    const leaders = new Set(
      [...projects.map((p) => p.leader?.terminal), ceo?.terminal].filter(Boolean)
    )
    for (const d of latest.values()) {
      if (leaders.has(d.handle) || businessOf(roots.get(d.handle), details)?.business.id !== b.id) {
        continue
      }
      const p = projectOf({ ...d, path: d.project }, projects, sent)
      const parent = parentFor(p, d)
      placed.add(d.handle)
      if (parent) {
        nodes.push({ ...dispatchedWorker(d, parent, b.id), projectId: p?.id })
      }
    }
    for (const w of workers.filter((w) => !placed.has(w.terminal) && !leaders.has(w.terminal))) {
      const p = projectOf({ handle: w.terminal, path: w.path }, projects, sent)
      const parent = parentFor(p)
      if (!parent) {
        continue
      }
      nodes.push({
        id: `worker:${b.id}:${w.dispatchId}`,
        kind: 'worker',
        parentId: parent,
        businessId: b.id,
        projectId: p?.id,
        label: w.agent,
        agent: w.agent,
        liveness: w.liveness,
        dispatchId: w.dispatchId,
        taskId: w.taskId || undefined,
        terminal: w.liveness === 'exited' ? undefined : w.terminal,
        state:
          w.liveness === 'exited'
            ? 'exited'
            : workerState(tasks.find((t) => t.id === w.taskId)?.status),
        activity: w.phase ?? tasks.find((t) => t.id === w.taskId)?.title ?? w.title,
        startedAt: w.startedAt || undefined
      })
    }
  }

  if (withProjects) {
    // 不属于任何业务的项目（比如在没登记的目录里 hiwd new 的）：按派单方所在目录分行，根是 project 节点（unregistered）
    const projects = new Map()
    for (const d of firsts) {
      if (businessOf(d, details)) {
        continue
      }
      const path = d.by.cwd ?? d.project
      projects.set(path, [...(projects.get(path) ?? []), d])
    }
    for (const [path, rows] of projects) {
      const seat = ownerSeat(sent, latest, path)
      const session =
        rows.findLast((d) => d.by.kind !== 'owner' && d.by.id !== 'opc-owner') ?? rows.at(-1)
      const agents = rows
        .map((d) => latest.get(d.handle))
        .filter((d) => d && d.handle !== seat?.handle)
      const working = agents.filter((d) => d.status === 'dispatched').length
      const projectId = `business:${path}`
      nodes.push({
        id: projectId,
        kind: 'business',
        project: path,
        label: path.split('/').pop() || path,
        unregistered: true,
        stats: [tally(rows)]
      })
      nodes.push({
        id: `leader:${path}`,
        kind: 'leader',
        parentId: projectId,
        project: path,
        label: 'Leader Agent',
        ...(seat
          ? {
              sublabel: agentName(seat.liveAgent ?? seat.agent),
              agent: seat.liveAgent ?? seat.agent,
              liveness: 'live',
              terminal: seat.handle,
              state: seatState(seat)
            }
          : {
              sublabel: session.by.label,
              agent: sessionAgent(session.by),
              dispatcher: session.by.id
            }),
        activity: working
          ? `${working} 个 Agent 在干活`
          : agents.length
            ? `${agents.length} 个 Agent 待命`
            : undefined
      })
      for (const d of agents) {
        nodes.push(dispatchedWorker(d, `leader:${path}`))
      }
    }
  }
  return { nodes }
}
