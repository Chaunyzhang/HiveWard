import { projectScheduleProjection } from './project-schedule.mjs'
import { decisionScreenshot } from './hiveward-decisions.mjs'
import { BROWSER_GATE_OPTIONS, isBrowserGateQuestion } from './hiveward-browser-gate.mjs'
import { hivewardEnvironment } from '../shared/environment.mjs'
import {
  businessProjects,
  migrateProjects,
  projectSummaries,
  projectOf,
  within
} from './business-projects.mjs'
import { updateBusiness, canonicalPath } from './business.mjs'
import { PERSONAL_AGENTS } from './harnesses.mjs'
import { rpc, optionalRpc, iso, json } from './api-runtime.mjs'
import { observeTerminal } from './business-terminals.mjs'
import { syncedBusinesses } from './projects.mjs'
import {
  dispatchTask,
  dispatchHalted,
  dispatchOnline,
  orchestrationProjection,
  legacyDispatches
} from './dispatches.mjs'
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
import { remoteOrigin } from './machine-identity.mjs'

export const OWNER = 'hiveward-owner' // HiveWard's explicit message address; never impersonate a coordinator.
// Set this to an actual HiveWard HQ run:<id> or terminal handle when a boss mailbox exists.
export const OWNER_MAILBOX = hivewardEnvironment.HIVEWARD_OWNER_MAILBOX
let cache,
  inFlight,
  version = 0
// 别的电脑开在本机的下属终端：派单记录要等第一句话送达后才写，这之前也不能被认成 Leader
const airborneLaunches = new Set()
export const markAirborneLaunch = (handle) => airborneLaunches.add(handle)

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
async function collect() {
  const { rows: registrations, identities } = await syncedBusinesses()
  const [status, listed, worktrees] = await Promise.all([
    rpc('status.get'),
    rpc('terminal.list'),
    optionalRpc('worktree.list')
  ])
  const source = await orchestrationProjection(
    listed.terminals,
    new Map((worktrees?.worktrees ?? []).map((w) => [w.id, w.path]))
  )
  const sent = source.rows
  const terminals = await Promise.all(
    listed.terminals
      .filter((t) =>
        registrations.some(
          (b) =>
            within(t.worktreePath, b.workspacePath) ||
            t.handle === b.leaderTerminal ||
            t.handle === b.ceo?.terminal
        )
      )
      .map(observeTerminal)
  )
  const details = []
  const orphanTasks = []
  const orphanDecisions = []
  const timeline = { gates: [], workers: [], tasks: [], decisionMessages: [], dispatches: [] }
  const claimed = new Set()
  for (let business of registrations) {
    if (!business.leaderTerminal) {
      const leader = terminals.find(
        (t) =>
          canonicalPath(t.worktreePath) === canonicalPath(business.workspacePath) &&
          t.handle !== business.ceo?.terminal &&
          t.agent === business.leaderAgent &&
          !sent.some((d) => d.handle === t.handle)
      )
      if (leader) {
        business = updateBusiness(business.id, {
          leaderTerminal: leader.handle,
          leaderStartedAt: leader.startedAt
        })
      }
    }
    migrateProjects(business, terminals, sent)
    const projects = businessProjects(business.id)
    const parties = [
      ...new Set(
        [
          business.ceo?.native?.party.address ?? business.ceo?.terminal,
          ...projects.map((p) => p.leader?.native?.party.address ?? p.leader?.terminal),
          ...source.rows.map((d) => d.party.address)
        ].filter(Boolean)
      )
    ]
    const crews = new Map(
      await Promise.all(
        parties.map(async (party) => [
          party,
          await rpc('orchestration.hivewardCrewShow', { party })
        ])
      )
    )
    const leaders = [
      business.leaderTerminal,
      business.ceo?.terminal,
      ...projects.map((p) => p.leader?.terminal)
    ].filter(Boolean)
    const groups = source.groups
      .map((group) => ({
        ...group,
        rows: group.rows.filter(
          (row) =>
            (business.runIds ?? []).includes(group.run.id) ||
            leaders.includes(row.party.address) ||
            within(row.project, business.workspacePath)
        )
      }))
      .filter((group) => group.rows.length || (business.runIds ?? []).includes(group.run.id))
    const tasks = [],
      workers = [],
      objectives = [],
      decisions = []
    for (const group of groups) {
      const { run, rows, gates } = group
      const haltedFor = (taskId, dispatchId) => {
        const row = rows.find(
          (item) => (dispatchId && item.dispatchId === dispatchId) || (taskId && item.id === taskId)
        )
        return row ? dispatchHalted(row) : false
      }
      for (const d of rows) {
        claimed.add(d.id)
        d.projectId = projectOf({ handle: d.handle, path: d.project }, projects, sent)?.id
        const task = dispatchTask(d, business.id)
        task.deps = d.deps
        tasks.push(task)
        if (d.worker) {
          if (d.online) {
            workers.push({
              dispatchId: d.dispatchId,
              taskId: d.id,
              agent: d.agent,
              liveness: d.liveness,
              terminalState: d.terminalState,
              startedAt: d.at,
              terminal: d.alive ? d.handle : undefined,
              path: d.project
            })
          }
          timeline.workers.push({
            dispatch: d.worker,
            shown: d.detail,
            agent: d.agent,
            startedAt: d.at,
            business
          })
        }
        const messages = source.inbox.filter(
          (m) => m.type === 'worker_done' && json(m.payload, {}).dispatchId === d.dispatchId
        )
        timeline.tasks.push({
          task: d.task,
          worker: workers.at(-1),
          done: messages[0],
          workerReports: messages,
          business,
          title: task.title
        })
      }
      const done = rows.filter((d) => d.status === 'completed').length
      objectives.push({
        id: run.id,
        runId: run.id,
        businessId: business.id,
        title: run.objective,
        status:
          rows.length && done === rows.length
            ? 'done'
            : rows.some((d) => d.status === 'failed')
              ? 'failed'
              : 'running',
        progress: { done, total: rows.length },
        createdAt: iso(run.created_at)
      })
      for (const gate of gates) {
        timeline.gates.push({ gate, business })
        if (gate.status === 'pending') {
          decisions.push({
            id: gate.id,
            businessId: business.id,
            objectiveId: run.id,
            source: 'gate',
            taskId: gate.task_id,
            question: gate.question,
            options: json(gate.options, []),
            urgency: 'normal',
            state: haltedFor(gate.task_id) ? 'expired' : 'pending',
            createdAt: iso(gate.created_at)
          })
        }
      }
    }
    const runIds = new Set(groups.map((g) => g.run.id))
    const haltedDecision = (group, payload) => {
      const row = group?.rows.find(
        (item) =>
          (payload.dispatchId && item.dispatchId === payload.dispatchId) ||
          (payload.taskId && item.id === payload.taskId)
      )
      return row ? dispatchHalted(row) : false
    }
    for (const message of source.inbox) {
      if (!['escalation', 'question'].includes(message.type) || !runIds.has(message.run_id)) {
        continue
      }
      const group = groups.find((g) => g.run.id === message.run_id)
      const recipient = message.to_handle
      const ownerAddress =
        group?.run.hivewardSession?.dispatcher.kind === 'owner'
          ? group.run.coordinatorAddress
          : OWNER_MAILBOX
      if (!ownerAddress || ![ownerAddress, `run:${message.run_id}`].includes(recipient)) {
        continue
      }
      const payload = json(message.payload, {})
      const halted = haltedDecision(group, payload)
      const reply = source.inbox.find(
        (m) =>
          m.thread_id === (message.thread_id ?? message.id) &&
          m.from_handle === (group.run.coordinatorAddress ?? group.run.coordinator_handle)
      )
      timeline.decisionMessages.push({ message, reply, business })
      decisions.push({
        id: message.id,
        businessId: business.id,
        objectiveId: message.run_id,
        source: message.type,
        question: message.subject,
        body: message.body,
        screenshot: decisionScreenshot(message.body),
        options: isBrowserGateQuestion(message.body)
          ? BROWSER_GATE_OPTIONS
          : (payload.options ?? []),
        urgency: message.priority === 'normal' ? 'normal' : 'high',
        state: reply ? 'resolved' : halted ? 'expired' : 'pending',
        createdAt: iso(message.created_at),
        resolution: reply ? { choice: reply.body, resolvedAt: iso(reply.created_at) } : undefined
      })
    }
    const leaderTerminal = terminals.find((t) => t.handle === business.leaderTerminal)
    const identity = identities.get(business.id) ?? (await businessIdentity(business))
    const leader = business.leaderTerminal
      ? {
          id: business.leaderTerminal,
          agent: business.leaderAgent,
          model: business.leaderModel,
          liveness: leaderTerminal ? 'live' : 'exited',
          state: leaderTerminal ? 'live' : 'stale',
          comment:
            worktrees?.worktrees?.find((w) => w.path === business.workspacePath)?.comment ||
            undefined,
          startedAt: leaderTerminal?.startedAt ?? business.leaderStartedAt ?? ''
        }
      : null
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
        personalAgent: business.personalAgent ?? null,
        personalAgentBot: business.personalAgentBot ?? null,
        leader,
        crew: Object.fromEntries(crews),
        ceo: summarizeSeat(
          business.ceo,
          terminals,
          sent,
          crews.get(business.ceo?.native?.party.address ?? business.ceo?.terminal)
        ),
        projects: await Promise.all(
          projectSummaries(business.id, terminals, sent, workers, crews).map((project) =>
            projectScheduleProjection(project)
          )
        ),
        updatedAt: business.updatedAt,
        counts: {
          objectivesRunning: objectives.filter((o) => o.status === 'running').length,
          tasksOpen: tasks.filter((t) => !['completed', 'failed'].includes(t.status)).length,
          tasksDone: tasks.filter((t) => t.status === 'completed').length,
          workersLive: workers.filter((w) => w.liveness === 'live').length,
          decisionsPending: decisions.filter((d) => d.state === 'pending').length
        }
      },
      authority: business.authority,
      objectives,
      tasks,
      workers,
      decisions,
      recentEvents: []
    })
  }
  for (const d of sent.filter((row) => !claimed.has(row.id))) {
    orphanTasks.push(dispatchTask(d, ''))
  }
  recordTerminalSnapshot(listed.terminals, registrations)
  await captureAgentNotifications({
    rpc: optionalRpc,
    terminals: listed.terminals,
    worktrees: worktrees?.worktrees ?? [],
    businesses: registrations
  })
  appendTimelineEvents(timelineEventsFromSources(timeline))
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
    historicalTasks: legacyDispatches().map((d) => dispatchTask(d, '')),
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

/** 每个终端上的第一条派单：追加话跟着原派单走，独立派单按各自的发话方归业务 */
function rootByHandle(sent) {
  const roots = new Map()
  for (const d of sent) {
    if (!roots.has(d.handle)) {
      roots.set(d.handle, d)
    }
  }
  return roots
}

/** 派单归发话方业务：Grok 显式业务 / 发话方目录优先；老板直派或未登记目录发话再按项目、接活目录归属 */
function businessOf(d, details) {
  const live = details.filter((x) => ['active', 'paused'].includes(x.business.status))
  const remote = remoteOrigin(d)
  const id = !remote && d.by.kind === 'grok' && /^grok:(.+)$/.exec(d.by.id)?.[1]
  return (
    (id && live.find((x) => x.business.id === id)) ||
    (!remote && live.find((x) => within(d.by.cwd, x.business.workspacePath))) ||
    (d.projectId &&
      live.find(
        (x) =>
          x.business.projects?.some((p) => p.id === d.projectId) ||
          businessProjects(x.business.id).some((p) => p.id === d.projectId)
      )) ||
    live.find((x) => within(d.project, x.business.workspacePath))
  )
}

/** 接活方在自己业务里的座位 / 项目；跨业务发话时由调用方标成外援 */
function externalHome(d, details, sent) {
  for (const { business: b } of details) {
    if (seatOccupantId(b.ceo) === d.handle) {
      return { businessId: b.id, businessName: b.name, role: 'ceo' }
    }
    const project = (b.projects ?? []).find((p) => seatOccupantId(p.leader) === d.handle)
    if (project) {
      return {
        businessId: b.id,
        businessName: b.name,
        projectId: project.id,
        projectName: project.name,
        role: 'leader'
      }
    }
  }
  for (const { business: b, workers = [] } of details) {
    const worker = workers.find((w) => w.terminal === d.handle)
    if (!worker && !within(d.project, b.workspacePath)) {
      continue
    }
    const project = projectOf(
      { handle: d.handle, path: worker?.path ?? d.project },
      b.projects ?? [],
      sent
    )
    return {
      businessId: b.id,
      businessName: b.name,
      projectId: project?.id,
      projectName: project?.name,
      role: 'worker'
    }
  }
}

function dispatchedWorker(d, parentId, businessId, external, root = d) {
  return {
    id: `dispatch:${d.handle}`,
    kind: 'worker',
    parentId,
    businessId,
    label: d.liveAgent ?? d.agent ?? 'shell',
    agent: d.liveAgent ?? d.agent ?? undefined,
    liveness: 'live',
    terminal: d.handle,
    activity: root.title || (root.reworkPrompt ?? root.prompt).split('\n')[0].slice(0, 80),
    state: dispatchState[root.status],
    review: root.review?.state,
    errorStop: root.errorStop,
    startedAt: root.roundStartedAt ?? root.at,
    finishedAt: root.status === 'completed' ? root.report?.reportedAt : undefined,
    dispatchId: root.id,
    taskId: root.id,
    ...(root.execution
      ? {
          federation: { ...root.execution, dispatchId: root.dispatchId },
          nativeTerminal: root.nativeTerminal
        }
      : {}),
    ...(remoteOrigin(root) ? { dispatcherMachineId: root.by.machineId } : {}),
    ...(external ? { external } : {})
  }
}

function airborneGroups(rows) {
  const groups = new Map()
  for (const dispatch of rows) {
    const key = `${dispatch.by.machineId}:${dispatch.by.id}`
    const group = groups.get(key) ?? { source: dispatch, children: [] }
    group.children.push(dispatch)
    groups.set(key, group)
  }
  return groups
}

function airborneLeader(group, parentId, businessId, knownMachines) {
  const d = group.source
  const machine = knownMachines.find((item) => item.id === d.by.machineId)
  const children = [...new Set(group.children.map((item) => item.id))]
  const businessName = d.businessName ?? d.by.businessName
  return {
    id: `airborne:${d.by.machineId}:${d.by.id}`,
    // 派单记录暂未带来源座位种类，影子先用现有 Leader 节点表达。
    kind: 'leader',
    parentId,
    businessId,
    label: d.by.label,
    dispatcher: d.by.id,
    airborne: {
      machineId: d.by.machineId,
      machineName: machine?.name ?? d.by.machineId,
      dispatcherId: d.by.id,
      dispatcherLabel: d.by.label,
      ...(businessName ? { businessName } : {})
    },
    online: machine?.status === 'online' && machine.secure === true,
    // 来源电脑最后一次连上的时间：离线时影子卡写「最后消息 X 前」
    ...(machine?.lastSeenAt ? { lastSeenAt: machine.lastSeenAt } : {}),
    count: children.length,
    remoteChildren: children
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
// HiveWard 编排里的下属：按它手上任务的状态
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
 * Leader Agent 是登记的负责人；没有时，用在这块业务目录里派过活的会话（比如开在 ~/shop 的 Claude Code）。
 * withProjects：公司级再加上不属于任何业务的项目（比如 ~/hiveward），每个项目一行，只有直连。
 * allDetails：单业务页也传完整上下文，用来认发话方业务与接活方原属业务。
 */
export function topology(
  details,
  sent = [],
  withProjects = true,
  allDetails = details,
  knownMachines = []
) {
  const nodes = []
  const roots = rootByHandle(sent)
  const latest = new Map()
  const online = new Map()
  for (const d of sent) {
    if (d.alive) {
      latest.set(d.handle, d)
      if (dispatchOnline(d)) {
        online.set(d.handle, d)
      }
    }
  }
  const firsts = sent.filter((d) => !d.parent && roots.get(d.handle) === d)
  const live = details.filter((x) => ['active', 'paused'].includes(x.business.status))
  const placed = new Set()

  for (const { business: b, workers, tasks } of live) {
    const rootId = `business:${b.id}`
    const c = b.counts
    const projects = b.projects ?? []
    const mine = firsts.filter((d) => businessOf(d, allDetails)?.business.id === b.id)
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
        b.ceo?.state === 'failed' ||
        projects.some((p) => p.leader?.state === 'failed')
    })
    // Personal Agent 位：老板点进去选一家（PERSONAL_AGENTS）；没选时空着。节点 id / kind 沿用 grok
    const pa = b.personalAgent ? PERSONAL_AGENTS[b.personalAgent] : null
    nodes.push({
      id: `grok:${b.id}`,
      kind: 'grok',
      parentId: rootId,
      businessId: b.id,
      label: pa?.name ?? 'Personal Agent',
      agent: pa ? b.personalAgent : undefined,
      // 产品里具体选了哪个 Agent（Grok Bot 里的某个 Bot）；还没选时为空
      bot: (pa && b.personalAgentBot) || undefined,
      activity: !pa ? '空着，点开选一个' : grok.length ? tally(grok) : '还没派过活',
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
    const nativeParent = (d) => {
      if (d) {
        const manager = Object.entries(b.crew ?? {}).find(([, crew]) =>
          crew.sections.managing.some((row) =>
            row.openTarget?.kind === 'terminal'
              ? row.openTarget.handle === d.handle
              : row.openTarget?.kind === 'dispatch' &&
                row.openTarget.address === `dispatch:${d.dispatchId}`
          )
        )?.[0]
        if (manager) {
          if (manager === ceo?.native?.party.address || manager === ceo?.terminal) {
            return `ceo:${b.id}`
          }
          const project = projects.find((item) =>
            [item.leader?.native?.party.address, item.leader?.terminal].includes(manager)
          )
          if (project) {
            return `leader:${project.id}`
          }
          const parent = sent.findLast((item) => item.handle === manager)
          if (parent) {
            return `dispatch:${parent.handle}`
          }
        }
      }
      return undefined
    }
    for (const p of projects.filter((p) => p.status === 'active')) {
      const l = p.leader
      nodes.push({
        id: `leader:${p.id}`,
        kind: 'leader',
        parentId:
          nativeParent({ handle: l?.terminal, dispatchId: l?.native?.dispatchId }) ?? rootId,
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
      const parent = nativeParent(d)
      if (parent) {
        return parent
      }
      if (d?.by.kind === 'grok') {
        return `grok:${b.id}`
      }
      if (p?.status === 'archived') {
        return null
      }
      if (p) {
        return `leader:${p.id}`
      }
      // CEO 派的、老板在架构图上 CEO 后面直接派的（不归项目）：挂在 CEO 后面
      if (
        d?.by.kind === 'owner' ||
        (ceo && d?.by.kind !== 'grok' && d?.by.id === seatOccupantId(ceo))
      ) {
        return `ceo:${b.id}`
      }
      const id = `leader:${b.id}:unassigned`
      if (!nodes.some((n) => n.id === id)) {
        nodes.push({ id, kind: 'leader', parentId: rootId, businessId: b.id, label: '未归项目' })
      }
      return id
    }
    const airborne = airborneGroups(
      firsts.filter((d) => remoteOrigin(d) && businessOf(d, allDetails)?.business.id === b.id)
    )
    for (const group of airborne.values()) {
      nodes.push(airborneLeader(group, rootId, b.id, knownMachines))
    }
    const leaders = new Set(
      [...projects.map((p) => p.leader?.terminal), ceo?.terminal].filter(Boolean)
    )
    for (const d of online.values()) {
      const origin = d
      const owner = businessOf(origin, allDetails)
      if (leaders.has(d.handle) || owner?.business.id !== b.id) {
        continue
      }
      const home = externalHome(d, allDetails, sent)
      const external = home?.businessId === b.id ? undefined : home
      // 外援挂在发话方 CEO / Leader 下；项目按发话方找，不能沿用接活方在别的业务里的 projectId
      const p = external
        ? projectOf({ handle: d.by.id, path: d.by.cwd }, projects, sent)
        : projectOf({ ...d, path: d.project }, projects, sent)
      const parent = remoteOrigin(origin)
        ? `airborne:${origin.by.machineId}:${origin.by.id}`
        : parentFor(p, d)
      placed.add(`${b.id}:${d.handle}`)
      if (parent) {
        nodes.push({ ...dispatchedWorker(d, parent, b.id, external, origin), projectId: p?.id })
      }
    }
    for (const w of workers.filter(
      (w) => !placed.has(`${b.id}:${w.terminal}`) && !leaders.has(w.terminal)
    )) {
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
      if (businessOf(d, allDetails)) {
        continue
      }
      const path = remoteOrigin(d) ? d.project : (d.by.cwd ?? d.project)
      projects.set(path, [...(projects.get(path) ?? []), d])
    }
    for (const [path, rows] of projects) {
      const seat = ownerSeat(sent, latest, path)
      const session =
        rows.findLast((d) => d.by.kind !== 'owner' && d.by.id !== 'hiveward-owner') ?? rows.at(-1)
      const agents = rows
        .map((d) => online.get(d.handle))
        .filter((d) => d && d.handle !== seat?.handle)
      const remoteRows = rows.filter((d) => remoteOrigin(d))
      const remoteOnly = remoteRows.length === rows.length
      // 里面的 Agent 都关了：本地未登记目录不再显示，外来派单保留影子和最后状态。
      if (!seat && agents.length === 0 && remoteRows.length === 0) {
        continue
      }
      const working = agents.filter((d) => d.status === 'dispatched').length
      const projectId = `business:${path}`
      nodes.push({
        id: projectId,
        kind: 'business',
        project: path,
        label: remoteOnly ? '外来派单' : path.split(/[/\\]/).pop() || path,
        unregistered: true,
        stats: [tally(rows)]
      })
      if (!remoteOnly || seat) {
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
      }
      for (const group of airborneGroups(remoteRows).values()) {
        nodes.push(airborneLeader(group, projectId, undefined, knownMachines))
      }
      for (const d of agents) {
        const origin = d
        const parent = remoteOrigin(origin)
          ? `airborne:${origin.by.machineId}:${origin.by.id}`
          : `leader:${path}`
        nodes.push(dispatchedWorker(d, parent, undefined, undefined, origin))
      }
    }
  }
  return { nodes }
}
